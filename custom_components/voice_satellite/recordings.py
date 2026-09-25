"""Authenticated websocket API for opt-in, private wake-word recordings."""

from __future__ import annotations

import logging
from datetime import timedelta
from pathlib import Path

import voluptuous as vol

from homeassistant.auth.permissions.const import POLICY_CONTROL
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant
from homeassistant.helpers.event import async_track_time_interval

from .const import DOMAIN
from .recording_store import MAX_BASE64_CHARS, RecordingError, RecordingStore

_LOGGER = logging.getLogger(__name__)
_STORE_KEY = f"{DOMAIN}_recordings_store"
_ADMIN_COMMANDS = {"configure", "list", "get", "label", "delete"}


def _authorize(hass, connection, entity_id: str, command: str) -> str:
    """Resolve stable ownership before touching storage; never trust a file path."""
    user = connection.user
    if user is None:
        raise RecordingError("unauthorized", "Home Assistant authentication is required.")
    if command in _ADMIN_COMMANDS and not user.is_admin:
        raise RecordingError("unauthorized", "An administrator is required to review or configure recordings.")
    if command == "save" and not (user.is_admin or user.permissions.check_entity(entity_id, POLICY_CONTROL)):
        raise RecordingError("unauthorized", "Control permission for this satellite is required.")
    if not entity_id.startswith("assist_satellite."):
        raise RecordingError("not_found", "Voice Satellite entity not found.")
    for entity in hass.data.get(DOMAIN, {}).values():
        if getattr(entity, "entity_id", None) != entity_id:
            continue
        entry_id = getattr(getattr(entity, "_entry", None), "entry_id", None)
        if entry_id:
            return entry_id
    raise RecordingError("not_found", "Voice Satellite entity not found.")


def _store(hass: HomeAssistant) -> RecordingStore:
    # Keep the service outside hass.data[DOMAIN], whose values are entity objects.
    if _STORE_KEY not in hass.data:
        hass.data[_STORE_KEY] = RecordingStore(Path(hass.config.path(DOMAIN, "recordings")))
    return hass.data[_STORE_KEY]


async def _dispatch(hass, connection, msg, command: str) -> None:
    try:
        owner = _authorize(hass, connection, msg["entity_id"], command)
        store = _store(hass)
        if command == "config":
            method, args = store.config, (owner,)
        elif command == "configure":
            updates = {key: msg[key] for key in ("mode", "retention_days", "max_storage_mb") if key in msg}
            method, args = store.configure, (owner, updates)
        elif command == "save":
            method, args = store.save, (owner, msg["capture_id"], msg["audio_base64"], msg["metadata"])
        elif command == "list":
            method, args = store.list, (owner, msg.get("label"), msg.get("limit", 50), msg.get("offset", 0))
        elif command == "get":
            method, args = store.get, (owner, msg["recording_id"])
        elif command == "label":
            method, args = store.label, (owner, msg["recording_id"], msg["label"], msg.get("word_present"), connection.user.id)
        elif command == "delete":
            method, args = store.delete, (owner, msg["recording_id"])
        else:
            raise RecordingError("unknown_command", "Unknown recording command.")
        result = await hass.async_add_executor_job(method, *args)
    except RecordingError as err:
        connection.send_error(msg["id"], err.code, str(err))
        return
    except (OSError, ValueError, KeyError, TypeError):
        # Do not return disk paths, metadata, audio, or user credentials to clients.
        _LOGGER.warning("Wake recording storage operation failed (%s)", command)
        connection.send_error(msg["id"], "storage_error", "Recording storage is unavailable or inconsistent.")
        return
    connection.send_result(msg["id"], result)


@websocket_api.websocket_command({
    vol.Required("type"): "voice_satellite/recordings/config",
    vol.Required("entity_id"): str,
})
@websocket_api.async_response
async def ws_config(hass, connection, msg):
    await _dispatch(hass, connection, msg, "config")


@websocket_api.websocket_command({
    vol.Required("type"): "voice_satellite/recordings/configure",
    vol.Required("entity_id"): str,
    vol.Required("mode"): vol.In(("off", "save", "review")),
    vol.Optional("retention_days"): vol.All(int, vol.Range(min=1, max=365)),
    vol.Optional("max_storage_mb"): vol.All(int, vol.Range(min=1, max=2048)),
})
@websocket_api.async_response
async def ws_configure(hass, connection, msg):
    await _dispatch(hass, connection, msg, "configure")


@websocket_api.websocket_command({
    vol.Required("type"): "voice_satellite/recordings/save",
    vol.Required("entity_id"): str,
    vol.Required("capture_id"): vol.All(str, vol.Length(min=36, max=36)),
    vol.Required("audio_base64"): vol.All(str, vol.Length(min=1, max=MAX_BASE64_CHARS)),
    vol.Required("metadata"): dict,
})
@websocket_api.async_response
async def ws_save(hass, connection, msg):
    await _dispatch(hass, connection, msg, "save")


@websocket_api.websocket_command({
    vol.Required("type"): "voice_satellite/recordings/list",
    vol.Required("entity_id"): str,
    vol.Optional("label"): vol.In(("correct", "false_trigger", "unsure", "unreviewed")),
    vol.Optional("limit"): vol.All(int, vol.Range(min=1, max=100)),
    vol.Optional("offset"): vol.All(int, vol.Range(min=0, max=1000000)),
})
@websocket_api.async_response
async def ws_list(hass, connection, msg):
    await _dispatch(hass, connection, msg, "list")


@websocket_api.websocket_command({
    vol.Required("type"): "voice_satellite/recordings/review_list",
    vol.Optional("entity_id"): str,
    vol.Optional("label"): vol.In(("correct", "false_trigger", "unsure", "unreviewed")),
    vol.Optional("limit"): vol.All(int, vol.Range(min=1, max=100)),
    vol.Optional("offset"): vol.All(int, vol.Range(min=0, max=1000000)),
})
@websocket_api.async_response
async def ws_review_list(hass, connection, msg):
    """Review a station or all stations without registering a voice client."""
    try:
        if connection.user is None or not connection.user.is_admin:
            raise RecordingError("unauthorized", "An administrator is required to review recordings.")
        stations = []
        for entity in hass.data.get(DOMAIN, {}).values():
            entity_id = getattr(entity, "entity_id", None)
            if not isinstance(entity_id, str) or not entity_id.startswith("assist_satellite."):
                continue
            owner = _authorize(hass, connection, entity_id, "list")
            state = hass.states.get(entity_id) if getattr(hass, "states", None) else None
            name = state.attributes.get("friendly_name") if state else None
            stations.append({"entity_id": entity_id, "name": name or entity_id, "owner": owner})
        stations.sort(key=lambda station: (station["name"].casefold(), station["entity_id"]))
        selected = msg.get("entity_id")
        if selected is not None:
            _authorize(hass, connection, selected, "list")
        scoped = [station for station in stations if selected is None or station["entity_id"] == selected]
        result = await hass.async_add_executor_job(
            _store(hass).review_list, scoped, msg.get("label"), msg.get("limit", 50), msg.get("offset", 0))
        result["stations"] = [{"entity_id": station["entity_id"], "name": station["name"]} for station in stations]
        if selected is None:
            result["config"] = None  # All-station review never exposes a bulk settings action.
    except RecordingError as err:
        connection.send_error(msg["id"], err.code, str(err))
        return
    except (OSError, ValueError, KeyError, TypeError):
        _LOGGER.warning("Wake recording review listing failed")
        connection.send_error(msg["id"], "storage_error", "Recording storage is unavailable or inconsistent.")
        return
    connection.send_result(msg["id"], result)


@websocket_api.websocket_command({
    vol.Required("type"): "voice_satellite/recordings/get",
    vol.Required("entity_id"): str,
    vol.Required("recording_id"): str,
})
@websocket_api.async_response
async def ws_get(hass, connection, msg):
    await _dispatch(hass, connection, msg, "get")


@websocket_api.websocket_command({
    vol.Required("type"): "voice_satellite/recordings/label",
    vol.Required("entity_id"): str,
    vol.Required("recording_id"): str,
    vol.Required("label"): vol.In(("correct", "false_trigger", "unsure", "unreviewed")),
    vol.Optional("word_present"): vol.In(("present", "absent", "uncertain")),
})
@websocket_api.async_response
async def ws_label(hass, connection, msg):
    await _dispatch(hass, connection, msg, "label")


@websocket_api.websocket_command({
    vol.Required("type"): "voice_satellite/recordings/delete",
    vol.Required("entity_id"): str,
    vol.Required("recording_id"): str,
})
@websocket_api.async_response
async def ws_delete(hass, connection, msg):
    await _dispatch(hass, connection, msg, "delete")


def register(hass: HomeAssistant) -> None:
    """Register private recording commands once during integration setup."""
    for handler in (ws_config, ws_configure, ws_save, ws_list, ws_review_list, ws_get, ws_label, ws_delete):
        websocket_api.async_register_command(hass, handler)

    async def cleanup(_now) -> None:
        try:
            await hass.async_add_executor_job(_store(hass).cleanup)
        except (RecordingError, OSError, ValueError, KeyError, TypeError):
            _LOGGER.warning("Wake recording retention cleanup could not finish")

    # Retention also applies when capture is off and after a satellite is removed.
    # Integration-wide registration follows the lifetime of Home Assistant.
    async_track_time_interval(hass, cleanup, timedelta(hours=1))
