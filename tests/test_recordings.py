"""Exercise real recording storage and HA handlers without a HA installation."""

import ast
import asyncio
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import importlib.util
import io
import json
import logging
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid
import wave


SOURCE = Path(__file__).parents[1] / "custom_components/voice_satellite"
spec = importlib.util.spec_from_file_location("recording_store_under_test", SOURCE / "recording_store.py")
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)


def wav_audio(seconds=1, rate=16000, channels=1, width=2, value=0):
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(width)
        wav.setframerate(rate)
        wav.writeframes(bytes([value]) * int(seconds * rate * channels * width))
    return base64.b64encode(output.getvalue()).decode("ascii")


def metadata():
    return {"origin": "browser", "engine": "openWakeWord", "model": "Atlas", "session_id": str(uuid.uuid4()), "sample_rate": 16000, "trigger_sample": 16000, "capture_kind": "wake", "score": None}


def load_handlers():
    """Stub only HA wiring; execute unchanged handler bodies and real store."""
    tree = ast.parse((SOURCE / "recordings.py").read_text())
    tree.body = [node for node in tree.body if not isinstance(node, (ast.Import, ast.ImportFrom))]
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            node.decorator_list = []
    namespace = {
        "logging": logging, "Path": Path, "HomeAssistant": object,
        "DOMAIN": "voice_satellite", "POLICY_CONTROL": "control",
        "MAX_BASE64_CHARS": storage.MAX_BASE64_CHARS,
        "RecordingStore": storage.RecordingStore, "RecordingError": storage.RecordingError,
    }
    exec(compile(tree, str(SOURCE / "recordings.py"), "exec"), namespace)
    return namespace


class RecordingStoreTest(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "private_recordings"
        self.store = storage.RecordingStore(self.root)
        self.owner = "kitchen-config-entry"

    def enable(self, **kwargs):
        return self.store.configure(self.owner, {"mode": "save", **kwargs})

    def save(self, capture_id=None, audio=None, meta=None):
        return self.store.save(self.owner, capture_id or str(uuid.uuid4()), audio or wav_audio(), meta if meta is not None else metadata())

    def assert_code(self, code, callback):
        with self.assertRaises(storage.RecordingError) as context:
            callback()
        self.assertEqual(context.exception.code, code)

    def test_default_off_does_not_create_files(self):
        self.assertEqual(self.store.config(self.owner), storage.DEFAULT_CONFIG)
        self.assert_code("recording_disabled", self.save)
        self.assertFalse(self.root.exists())

    def test_round_trip_restart_and_explicit_labels(self):
        self.enable()
        data = wav_audio()
        saved = self.save(audio=data)
        restarted = storage.RecordingStore(self.root)
        loaded = restarted.get(self.owner, saved["id"])
        self.assertEqual(loaded["audio_base64"], data)
        self.assertEqual(loaded["item"]["label"], "unreviewed")
        self.assertEqual(loaded["item"]["word_present"], "uncertain")
        item = restarted.label(self.owner, saved["id"], "false_trigger", None, "user-1")
        self.assertEqual(item["word_present"], "uncertain", "Feedback must not imply absence of the word")
        item = restarted.label(self.owner, saved["id"], "correct", "present", "user-1")
        self.assertEqual(item["word_present"], "present")
        self.assertEqual(len(item["label_history"]), 2)
        self.assertEqual(restarted.list(self.owner, "correct")["total"], 1)
        self.assertEqual(restarted.list(self.owner, "false_trigger")["total"], 0)

    def test_retry_is_idempotent_and_different_audio_cannot_replace(self):
        self.enable()
        capture_id = str(uuid.uuid4())
        self.assertFalse(self.save(capture_id)["duplicate"])
        self.assertTrue(self.save(capture_id)["duplicate"])
        self.store.label(self.owner, capture_id, "correct", "present", "reviewer")
        self.assertTrue(self.save(capture_id)["duplicate"])
        self.assertEqual(self.store.get(self.owner, capture_id)["item"]["label"], "correct")
        self.assert_code("id_conflict", lambda: self.save(capture_id, wav_audio(value=1)))
        self.assertEqual(self.store.list(self.owner)["total"], 1)
        self.assertEqual(self.store.get(self.owner, capture_id)["audio_base64"], wav_audio())

    def test_uuid_paths_and_entity_ownership(self):
        self.enable()
        for invalid in ("../../config", "/etc/passwd", "C:\\private", "not-a-uuid", str(uuid.uuid4()).upper()):
            self.assert_code("invalid_format", lambda: self.save(invalid))
        saved = self.save()
        self.assert_code("not_found", lambda: self.store.get("other-entry", saved["id"]))
        self.assertEqual(self.store.list("other-entry")["total"], 0)
        self.assertTrue(all(path.is_relative_to(self.root) for path in self.root.rglob("*")))

    def test_corrupt_oversized_and_wrong_format_audio_rejected(self):
        self.enable()
        good = base64.b64decode(wav_audio())
        truncated_chunk = bytearray(good[:-2])
        truncated_chunk[4:8] = (len(truncated_chunk) - 8).to_bytes(4, "little")
        bad_alignment = bytearray(good)
        bad_alignment[32:34] = (4).to_bytes(2, "little")
        bad_files = [
            "!!!", "x" * (storage.MAX_BASE64_CHARS + 1),
            base64.b64encode(good[:-1]).decode(),
            base64.b64encode(good + b"hidden payload").decode(),
            base64.b64encode(truncated_chunk).decode(),
            base64.b64encode(bad_alignment).decode(),
            wav_audio(rate=44100), wav_audio(channels=2), wav_audio(width=1),
            wav_audio(seconds=11), wav_audio(seconds=0),
        ]
        for data in bad_files:
            with self.subTest(size=len(data)):
                self.assert_code("invalid_format", lambda: self.save(audio=data))
        self.assertEqual(self.store.list(self.owner)["total"], 0)

    def test_metadata_limits_and_no_credential_storage(self):
        self.enable()
        for bad in (
            {"arbitrary_path": "file"}, {"score": float("nan")}, {"score": 2},
            {"model": "x" * 513}, {"trigger_sample": 16001}, {"model_sha256": "no"},
            {"microphone_settings": {"access_token": "secret"}},
            {"captured_at": "2026-09-25T12:00:00"}, {"sample_rate": 8000},
        ):
            self.assert_code("invalid_format", lambda: self.save(meta=bad))
        self.assertEqual(self.store.list(self.owner)["total"], 0)

    def test_quota_rejects_new_clip_and_delete_releases_space(self):
        self.enable(max_storage_mb=1)
        audio = wav_audio(seconds=10)
        saved = [self.save(audio=audio) for _ in range(3)]
        self.assert_code("quota_exceeded", lambda: self.save(audio=audio))
        self.assertEqual(self.store.list(self.owner)["total"], 3)
        self.store.delete(self.owner, saved[0]["id"])
        self.save(audio=audio)
        self.assertLess(self.store._usage(self.owner), 1024 * 1024)

    def test_retention_uses_server_time_and_preserves_policy(self):
        start = datetime(2026, 9, 1, tzinfo=timezone.utc)
        with patch.object(storage, "_now", return_value=start):
            self.enable(retention_days=7)
            first = self.save(meta={"captured_at": "2099-01-01T00:00:00Z"})
        with patch.object(storage, "_now", return_value=start + timedelta(days=8)):
            self.assertEqual(self.store.list(self.owner)["total"], 0)
            self.assert_code("not_found", lambda: self.store.get(self.owner, first["id"]))
            self.assertEqual(self.store.config(self.owner)["mode"], "save")

    def test_atomic_metadata_failure_cleans_uncommitted_audio(self):
        self.enable()
        capture_id = str(uuid.uuid4())
        original = self.store._atomic
        def fail_metadata(path, value):
            if path.suffix == ".json":
                raise OSError("simulated disk full")
            original(path, value)
        with patch.object(self.store, "_atomic", side_effect=fail_metadata):
            with self.assertRaises(OSError):
                self.save(capture_id)
        self.assertEqual(self.store.list(self.owner)["total"], 0)
        self.assertFalse(list(self.root.rglob("*.wav")))
        self.assertFalse(list(self.root.rglob("*.tmp")))
        self.assertFalse(self.save(capture_id)["duplicate"])

    def test_idle_cleanup_expires_removed_satellite_recordings(self):
        start = datetime(2026, 9, 1, tzinfo=timezone.utc)
        with patch.object(storage, "_now", return_value=start):
            self.enable(retention_days=1)
            self.save()
            self.store.configure(self.owner, {"mode": "off"})
        with patch.object(storage, "_now", return_value=start + timedelta(days=2)):
            self.store.cleanup()
        self.assertFalse(list(self.root.rglob("*.wav")))
        self.assertEqual(len(list(self.root.rglob("*.json"))), 1, "Policy remains after audio expires")

    def test_existing_corrupted_audio_is_not_acknowledged_as_duplicate(self):
        self.enable()
        saved = self.save()
        _, wav_path = self.store._paths(self.owner, saved["id"])
        wav_path.write_bytes(b"broken")
        self.assert_code("storage_error", lambda: self.save(saved["id"]))
        self.assert_code("storage_error", lambda: self.store.get(self.owner, saved["id"]))

    def test_concurrent_retries_publish_only_one_clip(self):
        self.enable()
        capture_id = str(uuid.uuid4())
        with ThreadPoolExecutor(max_workers=8) as workers:
            responses = list(workers.map(lambda _: self.save(capture_id), range(24)))
        self.assertEqual(sum(not row["duplicate"] for row in responses), 1)
        self.assertEqual(self.store.list(self.owner)["total"], 1)
        self.assertFalse(list(self.root.rglob("*.tmp")))

    def test_symlink_is_never_read_or_overwritten(self):
        self.enable()
        capture_id = str(uuid.uuid4())
        _, wav_path = self.store._paths(self.owner, capture_id)
        outside = Path(self.temp.name) / "outside.wav"
        outside.write_bytes(b"must remain intact")
        try:
            wav_path.symlink_to(outside)
        except OSError:
            if os.name != "nt":
                raise  # Linux CI must exercise this path rather than silently skip.
            self.skipTest("This host does not permit creation of test symlinks")
        self.assert_code("storage_error", lambda: self.save(capture_id))
        self.assertEqual(outside.read_bytes(), b"must remain intact")

    def test_configuration_bounds_and_pagination(self):
        for updates in ({"mode": "anything"}, {"retention_days": 0}, {"max_storage_mb": 2049}, {"max_storage_mb": True}):
            self.assert_code("invalid_format", lambda: self.store.configure(self.owner, updates))
        self.enable()
        self.save()
        self.save()
        self.assertEqual(len(self.store.list(self.owner, limit=1)["items"]), 1)
        self.assertEqual(self.store.list(self.owner, limit=1, offset=2)["items"], [])


class RecordingHandlersTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.handlers = load_handlers()
        self.results = []
        self.errors = []
        self.executor_calls = []
        async def executor(method, *args):
            self.executor_calls.append(getattr(method, "__name__", "mocked_method"))
            return await asyncio.to_thread(method, *args)
        self.hass = SimpleNamespace(
            config=SimpleNamespace(path=lambda *parts: str(Path(self.temp.name).joinpath(*parts))),
            data={"voice_satellite": {
                "entry-1": SimpleNamespace(entity_id="assist_satellite.kitchen", _entry=SimpleNamespace(entry_id="entry-1")),
                "entry-2": SimpleNamespace(entity_id="assist_satellite.bedroom", _entry=SimpleNamespace(entry_id="entry-2")),
            }}, async_add_executor_job=executor,
        )
        self.user = SimpleNamespace(id="reviewer", is_admin=True, permissions=SimpleNamespace(check_entity=lambda entity, permission: False))
        self.connection = SimpleNamespace(user=self.user, send_result=lambda *args: self.results.append(args), send_error=lambda *args: self.errors.append(args))
        self.base = {"id": 13, "entity_id": "assist_satellite.kitchen"}

    async def call(self, name, **fields):
        await self.handlers[f"ws_{name}"](self.hass, self.connection, {**self.base, **fields})

    async def test_complete_api_round_trip_runs_storage_in_executor(self):
        await self.call("configure", mode="review")
        capture_id = str(uuid.uuid4())
        await self.call("save", capture_id=capture_id, audio_base64=wav_audio(), metadata=metadata())
        self.assertEqual(self.results[-1], (13, {"id": capture_id, "duplicate": False}))
        await self.call("get", recording_id=capture_id)
        self.assertEqual(self.results[-1][1]["audio_base64"], wav_audio())
        await self.call("label", recording_id=capture_id, label="false_trigger", word_present="absent")
        self.assertEqual(self.results[-1][1]["label_history"][-1]["reviewer"], "reviewer")
        await self.call("list", label="false_trigger")
        self.assertEqual(self.results[-1][1]["total"], 1)
        await self.call("delete", recording_id=capture_id)
        self.assertEqual(self.results[-1][1], {"deleted": True})
        self.assertEqual(self.executor_calls, ["configure", "save", "get", "label", "list", "delete"])
        self.assertFalse(self.errors)

    async def test_unauthenticated_and_nonadmin_review_cannot_touch_storage(self):
        self.connection.user = None
        await self.call("config")
        self.assertEqual(self.errors[-1][1], "unauthorized")
        self.connection.user = self.user
        self.user.is_admin = False
        for name in ("configure", "list", "get", "label", "delete"):
            await self.call(name)
            self.assertEqual(self.errors[-1][1], "unauthorized")
        self.assertFalse(self.executor_calls)
        self.assertFalse(list(Path(self.temp.name).rglob("*")))

    async def test_entity_control_permission_checked_before_upload(self):
        await self.call("configure", mode="save")
        self.user.is_admin = False
        args = dict(capture_id=str(uuid.uuid4()), audio_base64=wav_audio(), metadata=metadata())
        await self.call("save", **args)
        self.assertEqual(self.errors[-1][1], "unauthorized")
        checked = []
        self.user.permissions.check_entity = lambda entity, policy: checked.append((entity, policy)) or True
        await self.call("save", **args)
        self.assertEqual(checked, [("assist_satellite.kitchen", "control")])
        self.assertFalse(self.results[-1][1]["duplicate"])
        await self.call("get", recording_id=args["capture_id"])
        self.assertEqual(self.errors[-1][1], "unauthorized", "Upload permission must not grant review access")

    async def test_wrong_entity_and_cross_entity_recording_access(self):
        await self.call("configure", mode="save")
        capture_id = str(uuid.uuid4())
        await self.call("save", capture_id=capture_id, audio_base64=wav_audio(), metadata=metadata())
        await self.call("get", entity_id="assist_satellite.bedroom", recording_id=capture_id)
        self.assertEqual(self.errors[-1][1], "not_found")
        await self.call("config", entity_id="assist_satellite.not_registered")
        self.assertEqual(self.errors[-1][1], "not_found")

    async def test_disk_error_has_safe_message_and_no_save_ack(self):
        store = self.handlers["_store"](self.hass)
        with patch.object(store, "configure", side_effect=OSError("/private/path secret")):
            await self.call("configure", mode="save")
        self.assertFalse(self.results)
        self.assertEqual(self.errors[-1][1], "storage_error")
        self.assertNotIn("secret", self.errors[-1][2])
        self.assertNotIn("/private", self.errors[-1][2])


if __name__ == "__main__":
    unittest.main()
