"""Multi-client station lifecycle regressions without a Home Assistant install."""
import ast
import asyncio
import logging
from pathlib import Path
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).parents[1] / 'custom_components/voice_satellite'


def extracted(path, names, namespace, class_name=None):
    tree = ast.parse(path.read_text(encoding='utf-8'))
    body = next(n.body for n in tree.body if isinstance(n, ast.ClassDef) and n.name == class_name) if class_name else tree.body
    nodes = [n for n in body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in names]
    for node in nodes:
        node.decorator_list = []
    future = ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0)
    exec(compile(ast.fix_missing_locations(ast.Module(body=[future, *nodes], type_ignores=[])), str(path), 'exec'), namespace)


class Connection:
    def __init__(self, user='admin'):
        self.user = SimpleNamespace(id=user)
        self.subscriptions = {}
        self.responses = []
        self.events = []
        self.binary_handlers = []

    def send_result(self, *args): self.responses.append(('ok', *args))
    def send_error(self, *args): self.responses.append(('error', *args))
    def send_event(self, *args): self.events.append(args)
    def async_register_binary_handler(self, callback):
        self.binary_handlers.append(callback)
        return 1, lambda: None


class RuntimeOwnershipTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        namespace = {'_LOGGER': logging.getLogger('runtime-test'), 'asyncio': asyncio}
        methods = ['register_satellite_subscription', 'is_runtime_owner', 'has_satellite_subscriber', 'unregister_satellite_subscription']
        extracted(ROOT / 'assist_satellite.py', methods, namespace, 'VoiceSatelliteEntity')
        entity_class = type('Station', (), {name: namespace[name] for name in methods})
        self.entity = entity_class()
        self.entity._satellite_subscribers = []
        self.entity._runtime_id = None
        self.entity._runtime_user_id = None
        self.entity._satellite_name = self.entity.satellite_name = 'Kitchen'
        self.entity._announce_event = asyncio.Event()
        self.entity._question_event = asyncio.Event()
        self.writes = []
        self.entity.async_write_ha_state = lambda: self.writes.append('station')
        self.entity._update_media_player_availability = lambda: self.writes.append('media')
        self.entity.pipeline_audio_queue = None
        self.entity.pipeline_task = None
        self.entity.set_pipeline_state = lambda value: self.writes.append(value)
        self.hass = SimpleNamespace(entities={'assist_satellite.kitchen': self.entity})
        namespace['_find_entity'] = lambda hass, entity_id: hass.entities.get(entity_id)
        handlers = ['ws_subscribe_satellite_events', 'ws_run_pipeline', 'ws_update_state']
        extracted(ROOT / '__init__.py', handlers, namespace)
        self.handlers = {name: namespace[name] for name in handlers}
        self.tablet = Connection()
        self.laptop = Connection()

    async def claim(self, conn, runtime='tablet', message_id=1):
        await self.handlers['ws_subscribe_satellite_events'](self.hass, conn, {
            'entity_id': 'assist_satellite.kitchen', 'id': message_id, 'runtime_id': runtime,
        })

    async def start_pipeline(self, conn, runtime='tablet'):
        await self.handlers['ws_run_pipeline'](self.hass, conn, {
            'entity_id': 'assist_satellite.kitchen', 'id': 2, 'runtime_id': runtime,
            'start_stage': 'stt', 'end_stage': 'tts', 'sample_rate': 16000,
        })

    async def test_laptop_cannot_claim_or_interrupt_tablet_turn(self):
        await self.claim(self.tablet)
        self.entity.pipeline_audio_queue = asyncio.Queue()
        await self.claim(self.laptop, 'laptop')
        await self.start_pipeline(self.laptop, 'laptop')
        self.assertEqual([r[2] for r in self.laptop.responses], ['satellite_in_use', 'satellite_in_use'])
        self.assertTrue(self.entity.has_satellite_subscriber(self.tablet))
        self.assertFalse(self.entity.has_satellite_subscriber(self.laptop))
        self.assertTrue(self.entity.pipeline_audio_queue.empty(), 'incumbent audio must not receive stop')
        self.assertEqual(self.tablet.events, [], 'never send displaced to incumbent')
        self.assertEqual(self.laptop.binary_handlers, [])

    async def test_reconnect_replaces_subscription_and_stale_close_cannot_release_it(self):
        await self.claim(self.tablet)
        old_unsubscribe = self.tablet.subscriptions[1]
        replacement = Connection()
        await self.claim(replacement, message_id=1)  # IDs repeat across sockets
        old_unsubscribe()
        self.assertTrue(self.entity.has_satellite_subscriber(replacement))
        self.assertFalse(self.entity.has_satellite_subscriber(self.tablet))
        self.assertFalse(self.entity._announce_event.is_set())
        self.assertFalse(self.entity._question_event.is_set())
        self.assertEqual(self.writes, ['station', 'media'])
        self.assertEqual(len(self.entity._satellite_subscribers), 1)

    async def test_same_socket_resubscribe_deduplicates_and_old_message_is_harmless(self):
        await self.claim(self.tablet)
        old_unsubscribe = self.tablet.subscriptions[1]
        await self.claim(self.tablet, message_id=10)
        old_unsubscribe()
        self.assertEqual(self.entity._satellite_subscribers, [(self.tablet, 10)])

    async def test_native_socket_requires_both_runtime_id_and_same_authenticated_user(self):
        await self.claim(self.tablet)
        native = Connection()
        self.assertTrue(self.entity.is_runtime_owner(native, 'tablet'))
        self.assertFalse(self.entity.is_runtime_owner(native, 'laptop'))
        self.assertFalse(self.entity.is_runtime_owner(native))
        self.assertFalse(self.entity.is_runtime_owner(Connection('other'), 'tablet'))
        await self.claim(Connection('other'), 'tablet')
        self.assertTrue(self.entity.has_satellite_subscriber(self.tablet))

    async def test_last_owner_close_releases_station_but_late_close_cannot_touch_new_owner(self):
        await self.claim(self.tablet)
        close = self.tablet.subscriptions[1]
        close()
        await self.claim(self.laptop, 'laptop')
        self.entity._announce_event.clear()
        writes = len(self.writes)
        close()
        self.assertTrue(self.entity.has_satellite_subscriber(self.laptop))
        self.assertEqual(len(self.writes), writes)
        self.assertFalse(self.entity._announce_event.is_set())

    async def test_non_owner_cannot_publish_idle_to_active_station(self):
        await self.claim(self.tablet)
        for conn in [self.laptop, self.tablet]:
            await self.handlers['ws_update_state'](self.hass, conn, {
                'id': 3, 'entity_id': 'assist_satellite.kitchen', 'state': 'IDLE',
            })
        self.assertEqual(self.laptop.responses[-1][2], 'satellite_in_use')
        self.assertEqual(self.writes.count('IDLE'), 1)

    async def test_ownership_is_rechecked_after_waiting_for_old_turn(self):
        await self.claim(self.tablet)
        async def old_turn():
            self.tablet.subscriptions[1]()
            await self.claim(self.laptop, 'laptop')
        self.entity.pipeline_task = asyncio.create_task(old_turn())
        await self.start_pipeline(self.tablet)
        self.assertEqual(self.tablet.responses[-1][2], 'satellite_in_use')
        self.assertEqual(self.tablet.binary_handlers, [])

    async def test_claimed_native_socket_can_start_pipeline(self):
        await self.claim(self.tablet)
        native = Connection()
        async def pipeline(*args, **kwargs): pass
        self.entity.async_run_pipeline = pipeline
        self.hass.async_create_background_task = lambda coro, **kwargs: asyncio.create_task(coro)
        await self.start_pipeline(native)
        await self.entity.pipeline_task
        self.assertEqual(native.responses[-1], ('ok', 2))
        self.assertEqual(native.events, [(2, {'type': 'init', 'handler_id': 1})])
        self.assertTrue(self.entity.has_satellite_subscriber(self.tablet))


if __name__ == '__main__':
    unittest.main()
