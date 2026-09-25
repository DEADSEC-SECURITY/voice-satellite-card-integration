"""Private, bounded wake-word recording storage (no Home Assistant imports)."""

from __future__ import annotations

import base64
import binascii
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import struct
import threading
from typing import Any
import uuid

DEFAULT_CONFIG = {"mode": "off", "retention_days": 7, "max_storage_mb": 250}
MAX_WAV_BYTES = 320044
MAX_BASE64_CHARS = 4 * ((MAX_WAV_BYTES + 2) // 3)
MAX_METADATA_BYTES = 8192
LABELS = {"correct", "false_trigger", "unsure", "unreviewed"}
WORD_PRESENCE = {"present", "absent", "uncertain"}
_METADATA_FIELDS = {
    "origin", "engine", "model", "model_sha256", "score", "threshold",
    "sensitivity", "session_id", "captured_at", "trigger_sample", "capture_kind",
    "sample_rate", "pre_seconds", "version", "microphone_settings", "discontinuity",
}


class RecordingError(Exception):
    """A safe error code and message suitable for returning to the client."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _invalid(message: str) -> None:
    raise RecordingError("invalid_format", message)


def _clip_id(value: Any) -> str:
    if not isinstance(value, str) or len(value) != 36:
        _invalid("Recording id must be a canonical UUID.")
    try:
        parsed = str(uuid.UUID(value))
    except ValueError:
        _invalid("Recording id must be a canonical UUID.")
    if value != parsed:
        _invalid("Recording id must be a canonical UUID.")
    return parsed


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _timestamp(value: Any) -> datetime:
    if not isinstance(value, str) or len(value) > 64:
        _invalid("Timestamp must include its timezone.")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        _invalid("Timestamp must be ISO 8601.")
    if parsed.tzinfo is None:
        _invalid("Timestamp must include its timezone.")
    return parsed.astimezone(timezone.utc)


def _bounded_json(value: Any, depth: int = 0) -> None:
    if depth > 3:
        _invalid("Metadata is too deeply nested.")
    if value is None or isinstance(value, bool):
        return
    if isinstance(value, (float, int)):
        if abs(value) > 10**15 or not math.isfinite(value):
            _invalid("Metadata numbers must be finite and bounded.")
    elif isinstance(value, str):
        if len(value) > 512:
            _invalid("Metadata strings are limited to 512 characters.")
    elif isinstance(value, list):
        if len(value) > 32:
            _invalid("Metadata lists are limited to 32 items.")
        for item in value:
            _bounded_json(item, depth + 1)
    elif isinstance(value, dict):
        if len(value) > 32:
            _invalid("Metadata objects are limited to 32 fields.")
        for key, item in value.items():
            if not isinstance(key, str) or len(key) > 64:
                _invalid("Invalid metadata field name.")
            if any(part in key.lower() for part in ("password", "token", "secret", "authorization", "credential")):
                _invalid("Credentials must not be included in recording metadata.")
            _bounded_json(item, depth + 1)
    else:
        _invalid("Metadata must contain JSON values.")


def _metadata(value: Any, frames: int) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) - _METADATA_FIELDS:
        _invalid("Unknown recording metadata fields.")
    _bounded_json(value)
    if len(json.dumps(value, allow_nan=False).encode()) > MAX_METADATA_BYTES:
        _invalid("Recording metadata is too large.")
    for field in ("engine", "model", "sensitivity", "session_id", "version"):
        if field in value and value[field] is not None and not isinstance(value[field], str):
            _invalid(f"{field} must be a string.")
    for field, allowed in (("origin", {"browser", "native"}), ("capture_kind", {"wake", "missed"})):
        if field in value and value[field] not in allowed:
            _invalid(f"Invalid {field}.")
    if "model_sha256" in value and value["model_sha256"] is not None:
        if not isinstance(value["model_sha256"], str) or not re.fullmatch(r"[0-9a-fA-F]{64}", value["model_sha256"]):
            _invalid("Invalid model SHA256.")
    for field in ("score", "threshold"):
        val = value.get(field)
        if val is not None and (isinstance(val, bool) or not isinstance(val, (float, int)) or not 0 <= val <= 1):
            _invalid(f"{field} must be null or a probability between zero and one.")
    if "captured_at" in value:
        _timestamp(value["captured_at"])
    if "sample_rate" in value and (type(value["sample_rate"]) is not int or value["sample_rate"] != 16000):
        _invalid("sample_rate must be 16000.")
    if "trigger_sample" in value and (type(value["trigger_sample"]) is not int or not 0 <= value["trigger_sample"] <= frames):
        _invalid("trigger_sample must lie within the recording.")
    if "pre_seconds" in value:
        val = value["pre_seconds"]
        if isinstance(val, bool) or not isinstance(val, (float, int)) or not 0 <= val <= 10:
            _invalid("pre_seconds must be between zero and ten.")
    if "microphone_settings" in value and not isinstance(value["microphone_settings"], dict):
        _invalid("microphone_settings must be an object.")
    if "discontinuity" in value and not isinstance(value["discontinuity"], (bool, str)):
        _invalid("discontinuity must be a boolean or description.")
    return json.loads(json.dumps(value, allow_nan=False))


def decode_wav(encoded: Any) -> tuple[bytes, int]:
    """Validate bounded, complete 16 kHz mono PCM16 WAV before any file write."""
    if not isinstance(encoded, str) or not encoded or len(encoded) > MAX_BASE64_CHARS:
        _invalid("Audio must be base64 WAV data no longer than ten seconds.")
    try:
        audio = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        _invalid("Invalid base64 audio.")
    if len(audio) < 44 or len(audio) > MAX_WAV_BYTES:
        _invalid("WAV size is outside the recording limit.")
    if audio[:4] != b"RIFF" or audio[8:12] != b"WAVE" or int.from_bytes(audio[4:8], "little") + 8 != len(audio):
        _invalid("WAV is incomplete or has trailing data.")
    offset = 12
    format_seen = False
    data_size = None
    while offset + 8 <= len(audio):
        chunk = audio[offset:offset + 4]
        size = int.from_bytes(audio[offset + 4:offset + 8], "little")
        start, end = offset + 8, offset + 8 + size
        if end > len(audio):
            _invalid("WAV contains a truncated chunk.")
        if chunk == b"fmt ":
            if format_seen or size < 16:
                _invalid("Invalid WAV format chunk.")
            # format, channels, rate, bytes/sec, block alignment, bits/sample
            if struct.unpack_from("<HHIIHH", audio, start) != (1, 1, 16000, 32000, 2, 16):
                _invalid("Audio must be 16 kHz mono PCM16 WAV.")
            format_seen = True
        elif chunk == b"data":
            if not format_seen or data_size is not None or not 2 <= size <= 320000 or size % 2:
                _invalid("Invalid WAV PCM data chunk.")
            data_size = size
        offset = end + size % 2
    if offset != len(audio) or not format_seen or data_size is None:
        _invalid("WAV structure is incomplete.")
    return audio, data_size // 2


class RecordingStore:
    """Thread-safe synchronous storage; callers run operations in HA's executor."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self._lock = threading.RLock()

    def _safe(self, path: Path) -> Path:
        # Entry identifiers are hashed and clip names are UUIDs. Reject symlinks
        # as well, including pre-existing subdirectories inside the private root.
        relative = path.relative_to(self.root)
        current = self.root
        for part in (None, *relative.parts):
            if part is not None:
                current /= part
            if current.is_symlink():
                raise RecordingError("storage_error", "Recording storage contains an unsafe path.")
        if not path.resolve().is_relative_to(self.root.resolve()):
            raise RecordingError("storage_error", "Recording path is outside private storage.")
        return path

    def _dir(self, owner: str) -> Path:
        if not isinstance(owner, str) or not owner or len(owner) > 256:
            _invalid("Invalid satellite identity.")
        return self._safe(self.root / hashlib.sha256(owner.encode()).hexdigest())

    def _read_json(self, path: Path) -> dict:
        self._safe(path)
        if path.stat().st_size > 65536:
            raise RecordingError("storage_error", "Recording metadata is unreadable.")
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (ValueError, UnicodeError) as err:
            raise RecordingError("storage_error", "Recording metadata is unreadable.") from err
        if not isinstance(value, dict):
            raise RecordingError("storage_error", "Recording metadata is unreadable.")
        return value

    def _atomic(self, path: Path, payload: bytes) -> None:
        self._safe(path)
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temp = self._safe(path.with_name(f".{path.name}.{uuid.uuid4()}.tmp"))
        try:
            with os.fdopen(os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "wb") as output:
                output.write(payload)
                output.flush()
                os.fsync(output.fileno())
            temp.replace(path)
            if os.name != "nt":
                directory_fd = os.open(path.parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
        finally:
            temp.unlink(missing_ok=True)

    def _write_json(self, path: Path, value: dict) -> None:
        self._atomic(path, json.dumps(value, allow_nan=False, separators=(",", ":")).encode())

    def config(self, owner: str) -> dict:
        with self._lock:
            path = self._dir(owner) / "config.json"
            config = dict(DEFAULT_CONFIG)
            if path.exists():
                config.update(self._read_json(path))
            return config

    def configure(self, owner: str, updates: dict) -> dict:
        with self._lock:
            if set(updates) - set(DEFAULT_CONFIG):
                _invalid("Unknown recording policy fields.")
            config = {**self.config(owner), **updates}
            if config["mode"] not in {"off", "save", "review"}:
                _invalid("Recording mode must be off, save, or review.")
            for field, maximum in (("retention_days", 365), ("max_storage_mb", 2048)):
                if type(config[field]) is not int or not 1 <= config[field] <= maximum:
                    _invalid(f"{field} must be an integer between 1 and {maximum}.")
            self._write_json(self._dir(owner) / "config.json", config)
            self._prune(owner, config)
            return config

    def _paths(self, owner: str, recording_id: str) -> tuple[Path, Path]:
        recording_id = _clip_id(recording_id)
        directory = self._dir(owner)
        return self._safe(directory / f"{recording_id}.json"), self._safe(directory / f"{recording_id}.wav")

    def _rows(self, owner: str) -> list[dict]:
        directory = self._dir(owner)
        rows = []
        for path in directory.glob("*.json"):
            if path.name == "config.json":
                continue
            _clip_id(path.stem)
            row = self._read_json(path)
            if row.get("id") != path.stem:
                raise RecordingError("storage_error", "Recording identity is inconsistent.")
            self._safe(path.with_suffix(".wav"))
            rows.append(row)
        return rows

    def _prune(self, owner: str, config: dict) -> None:
        self._prune_directory(self._dir(owner), config)

    def _prune_directory(self, directory: Path, config: dict) -> None:
        cutoff = _now() - timedelta(days=config["retention_days"])
        for path in directory.glob("*.json"):
            if path.name == "config.json":
                continue
            _clip_id(path.stem)
            row = self._read_json(path)
            if _timestamp(row["created_at"]) < cutoff:
                wav_path = self._safe(path.with_suffix(".wav"))
                path.unlink()
                wav_path.unlink(missing_ok=True)
        # Recover files left by a killed process; never publish incomplete uploads.
        # The full retention period allows queued clients plenty of time to retry.
        for path in directory.glob("*.wav"):
            _clip_id(path.stem)
            self._safe(path)
            if not self._safe(path.with_suffix(".json")).exists() and path.stat().st_mtime < cutoff.timestamp():
                path.unlink()
        for path in directory.glob(".*.tmp"):
            self._safe(path)
            if path.stat().st_mtime < cutoff.timestamp():
                path.unlink()

    def cleanup(self) -> None:
        """Expire clips even if capture is off or a satellite was removed."""
        with self._lock:
            self._safe(self.root)
            if not self.root.exists():
                return
            for directory in self.root.iterdir():
                if not re.fullmatch(r"[0-9a-f]{64}", directory.name):
                    continue
                self._safe(directory)
                if not directory.is_dir():
                    continue
                path = self._safe(directory / "config.json")
                config = {**DEFAULT_CONFIG, **(self._read_json(path) if path.exists() else {})}
                self._prune_directory(directory, config)

    def _usage(self, owner: str) -> int:
        return sum(self._safe(path).stat().st_size for path in self._dir(owner).iterdir() if path.suffix in {".wav", ".json"} and path.name != "config.json")

    def save(self, owner: str, capture_id: str, audio_base64: str, metadata: dict) -> dict:
        with self._lock:
            config = self.config(owner)
            if config["mode"] == "off":
                raise RecordingError("recording_disabled", "Wake-word recording is disabled for this satellite.")
            recording_id = _clip_id(capture_id)
            audio, frames = decode_wav(audio_base64)
            metadata = _metadata(metadata, frames)
            digest = hashlib.sha256(audio).hexdigest()
            meta_path, wav_path = self._paths(owner, recording_id)
            self._prune(owner, config)
            if meta_path.exists():
                old = self._read_json(meta_path)
                if old.get("sha256") != digest:
                    raise RecordingError("id_conflict", "Capture id was already used for different audio.")
                if not wav_path.exists() or wav_path.stat().st_size > MAX_WAV_BYTES or hashlib.sha256(wav_path.read_bytes()).hexdigest() != digest:
                    raise RecordingError("storage_error", "The saved recording is incomplete.")
                return {"id": recording_id, "duplicate": True}
            row = {
                "id": recording_id, "capture_id": capture_id,
                "created_at": _now().isoformat(), "metadata": metadata,
                "label": "unreviewed", "word_present": "uncertain",
                "bytes": len(audio), "sha256": digest, "label_history": [],
            }
            row_bytes = json.dumps(row, allow_nan=False, separators=(",", ":")).encode()
            orphan_bytes = wav_path.stat().st_size if wav_path.exists() else 0
            if self._usage(owner) - orphan_bytes + len(audio) + len(row_bytes) > config["max_storage_mb"] * 1024 * 1024:
                raise RecordingError("quota_exceeded", "Recording storage is full. Review or delete saved recordings.")
            # JSON is the commit marker: incomplete WAVs never appear in the inbox.
            # An orphan from an interrupted save may be safely replaced by this retry.
            self._atomic(wav_path, audio)
            try:
                self._atomic(meta_path, row_bytes)
            except Exception:
                wav_path.unlink(missing_ok=True)
                raise
            return {"id": recording_id, "duplicate": False}

    def list(self, owner: str, label: str | None = None, limit: int = 50, offset: int = 0) -> dict:
        with self._lock:
            if label is not None and label not in LABELS:
                _invalid("Invalid review label.")
            if type(limit) is not int or not 1 <= limit <= 100 or type(offset) is not int or not 0 <= offset <= 1000000:
                _invalid("Invalid recording page.")
            config = self.config(owner)
            self._prune(owner, config)
            rows = [row for row in self._rows(owner) if label is None or row["label"] == label]
            rows.sort(key=lambda row: (row["created_at"], row["id"]), reverse=True)
            return {"items": rows[offset:offset + limit], "total": len(rows), "config": config}

    def get(self, owner: str, recording_id: str) -> dict:
        with self._lock:
            self._prune(owner, self.config(owner))
            meta_path, wav_path = self._paths(owner, recording_id)
            if not meta_path.exists() or not wav_path.exists():
                raise RecordingError("not_found", "Recording not found.")
            row = self._read_json(meta_path)
            if wav_path.stat().st_size > MAX_WAV_BYTES:
                raise RecordingError("storage_error", "Recording data is invalid.")
            audio = wav_path.read_bytes()
            if hashlib.sha256(audio).hexdigest() != row.get("sha256"):
                raise RecordingError("storage_error", "Recording data is incomplete.")
            return {"item": row, "audio_base64": base64.b64encode(audio).decode("ascii")}

    def label(self, owner: str, recording_id: str, label: str, word_present: str | None, reviewer: str) -> dict:
        with self._lock:
            if label not in LABELS or (word_present is not None and word_present not in WORD_PRESENCE):
                _invalid("Invalid recording label or word presence.")
            row = self.get(owner, recording_id)["item"]
            row["label"] = label
            if word_present is not None:
                row["word_present"] = word_present
            # Keep explicit feedback separate from acoustic presence. A 'bad'
            # trigger may still contain the word; never infer a training label.
            history = row.get("label_history", [])[-19:]
            history.append({"label": label, "word_present": row["word_present"], "reviewer": reviewer, "at": _now().isoformat()})
            row["label_history"] = history
            meta_path, _ = self._paths(owner, recording_id)
            new_bytes = json.dumps(row, allow_nan=False, separators=(",", ":")).encode()
            if self._usage(owner) - meta_path.stat().st_size + len(new_bytes) > self.config(owner)["max_storage_mb"] * 1024 * 1024:
                raise RecordingError("quota_exceeded", "Recording storage is full. Delete a recording or increase its limit.")
            self._write_json(meta_path, row)
            return row

    def delete(self, owner: str, recording_id: str) -> dict:
        with self._lock:
            meta_path, wav_path = self._paths(owner, recording_id)
            if not meta_path.exists() and not wav_path.exists():
                raise RecordingError("not_found", "Recording not found.")
            # Removing metadata first hides the clip even if the audio removal fails.
            meta_path.unlink(missing_ok=True)
            wav_path.unlink(missing_ok=True)
            return {"deleted": True}
