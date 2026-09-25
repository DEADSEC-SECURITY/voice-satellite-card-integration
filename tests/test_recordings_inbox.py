"""Review inbox authorization, global ordering, and owner routing."""
import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

import test_recordings as fixtures

metadata, storage, wav_audio = fixtures.metadata, fixtures.storage, fixtures.wav_audio


class RecordingInboxStoreTest(unittest.TestCase):
    setUp = fixtures.RecordingStoreTest.setUp
    assert_code = fixtures.RecordingStoreTest.assert_code

    def test_global_pagination_uses_all_owners_before_slicing_and_applies_retention(self):
        stations = [
            {"owner": "kitchen", "entity_id": "assist_satellite.kitchen", "name": "Kitchen tablet"},
            {"owner": "office", "entity_id": "assist_satellite.office", "name": "Office"},
        ]
        now = datetime(2026, 9, 25, tzinfo=timezone.utc)
        ids = [str(uuid.uuid4()) for _ in range(4)]
        for station in stations:
            self.store.configure(station["owner"], {"mode": "save", "retention_days": 1})
        for index, (owner, age) in enumerate((("kitchen", 0), ("office", 1), ("kitchen", 2), ("office", 48))):
            with patch.object(storage, "_now", return_value=now - timedelta(hours=age)):
                self.store.save(owner, ids[index], wav_audio(), metadata())
        with patch.object(storage, "_now", return_value=now):
            page = self.store.review_list(stations, limit=1, offset=1)
            self.assertEqual(page["total"], 3)
            self.assertEqual(page["items"][0]["id"], ids[1])
            self.assertEqual(page["items"][0]["entity_id"], "assist_satellite.office")
            self.assertEqual(page["items"][0]["station_name"], "Office")
            self.assertNotIn("owner", page["items"][0])
            self.assertIsNone(page["config"])
            self.assertEqual(self.store.review_list(stations[:1])["config"]["mode"], "save")
            self.store.label("office", ids[1], "false_trigger", "absent", "admin")
            filtered = self.store.review_list(stations, label="false_trigger")
            self.assertEqual(filtered["total"], 1)
            self.assertEqual(filtered["items"][0]["id"], ids[1])
        for kwargs in ({"limit": 101}, {"offset": -1}, {"label": "bad"}, {"limit": True}):
            self.assert_code("invalid_format", lambda: self.store.review_list(stations, **kwargs))


class RecordingInboxHandlersTest(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixtures.RecordingHandlersTest.asyncSetUp
    call = fixtures.RecordingHandlersTest.call

    async def review(self, **fields):
        await self.handlers["ws_review_list"](self.hass, self.connection, {"id": 50, **fields})

    async def test_admin_listing_resolves_actual_station_identity_without_client_registration(self):
        self.hass.states = SimpleNamespace(get=lambda entity: SimpleNamespace(attributes={"friendly_name": "Kitchen tablet" if "kitchen" in entity else "Bedroom"}))
        await self.call("configure", mode="review")
        capture_id = str(uuid.uuid4())
        await self.call("save", capture_id=capture_id, audio_base64=wav_audio(), metadata=metadata())
        await self.review()
        result = self.results[-1][1]
        self.assertEqual(result["items"][0]["entity_id"], "assist_satellite.kitchen")
        self.assertEqual(result["items"][0]["station_name"], "Kitchen tablet")
        self.assertEqual(len(result["stations"]), 2)
        self.assertTrue(all(set(station) == {"entity_id", "name"} for station in result["stations"]))
        self.assertIsNone(result["config"])
        await self.review(entity_id="assist_satellite.bedroom")
        self.assertEqual(self.results[-1][1]["items"], [])
        self.assertEqual(self.results[-1][1]["config"]["mode"], "off")
        self.assertEqual(self.executor_calls, ["configure", "save", "review_list", "review_list"])

    async def test_all_station_review_requires_admin_before_enumeration_or_storage(self):
        for user in (None, SimpleNamespace(is_admin=False)):
            self.connection.user = user
            await self.review()
            self.assertEqual(self.errors[-1][1], "unauthorized")
        self.assertFalse(self.executor_calls)
        self.assertFalse(self.results)

    async def test_invalid_station_cannot_fall_back_to_all_and_storage_error_is_redacted(self):
        await self.review(entity_id="assist_satellite.unknown")
        self.assertEqual(self.errors[-1][1], "not_found")
        self.assertFalse(self.executor_calls)
        store = self.handlers["_store"](self.hass)
        with patch.object(store, "review_list", side_effect=OSError("/private/path secret")):
            await self.review()
        self.assertEqual(self.errors[-1][1], "storage_error")
        self.assertNotIn("secret", self.errors[-1][2])
        self.assertNotIn("private", self.errors[-1][2])


if __name__ == "__main__":
    unittest.main()
