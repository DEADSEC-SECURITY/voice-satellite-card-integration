const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const noop = () => {};
const flush = async () => {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
};
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
async function fixture() {
  const timers = new Map();
  const listeners = new Map();
  const requests = [];
  const unsubs = [];
  const callbacks = [];
  let timerId = 0;
  const context = vm.createContext({
    console,
    __VERSION__: 'test',
    window: { location: { pathname: '/voice-satellite-recordings' } },
    localStorage: { getItem: () => null },
    setTimeout(fn, delay) {
      timers.set(++timerId, { fn, delay });
      return timerId;
    },
    setInterval(fn, delay) {
      timers.set(++timerId, { fn, delay });
      return timerId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    clearInterval(id) {
      timers.delete(id);
    },
  });
  const stubs = {
    'src/shared/satellite-notification.js': {
      resetNotificationDedup: noop,
      teardownVisibilityListener: noop,
      dispatchSatelliteEvent: noop,
      playQueuedNotifications: noop,
      releaseNotificationInteraction: noop,
    },
    'src/audio/chime.js': {
      preloadChimes: noop,
      setChimeDurationOverrides: noop,
      refreshNativeChimeDurations: async () => {},
      getChimeDuration: noop,
      CHIME_WAKE: {},
    },
    'src/wake-word/native-handoff.js': {
      setupNativeWakeHandoff: async () => {
        calls.native++;
      },
      teardownNativeWakeHandoff: noop,
      nativeEngineFor: noop,
    },
    'src/kiosk/index.js': {},
    'src/session': { VoiceSatelliteSession: class {} },
    'src/shared/entity-picker.js': {
      resolveEntity: () => {
        calls.resolve++;
        return 'assist_satellite.kitchen';
      },
    },
    'src/memory-sampler.js': { startDiagnostics: noop },
    'src/toast/overlay-ui.js': { mountOverlayToast: noop },
    'src/shared/external-settings.js': { installExternalSettings: noop },
  };
  const modules = new Map();
  function load(file) {
    if (modules.has(file)) {
      return modules.get(file);
    }
    const stub = stubs[path.relative(root, file).split(path.sep).join('/')];
    const source = stub
      ? null
      : readFileSync(file, 'utf8') +
        (file.endsWith(path.join('engine', 'index.js')) ? '\nexport { attemptStart };' : '');
    const m = stub
      ? new vm.SyntheticModule(
          Object.keys(stub),
          function () {
            for (const [k, value] of Object.entries(stub)) {
              this.setExport(k, value);
            }
          },
          { context, identifier: file }
        )
      : new vm.SourceTextModule(source, { context, identifier: file });
    modules.set(file, m);
    return m;
  }
  const entry = new vm.SourceTextModule(
    `
    export * from './src/shared/satellite-subscription.js';
    export { startListening } from './src/session/events.js';
    export * from './src/shared/server-settings.js';
    export { attemptStart } from './src/engine/index.js';
  `,
    { context, identifier: path.join(root, 'test-runtime-entry.js') }
  );
  await entry.link((specifier, parent) =>
    load(path.resolve(path.dirname(parent.identifier), specifier))
  );
  await entry.evaluate();
  const calls = { native: 0, mic: 0, recordings: 0, starts: 0, conflicts: 0, resolve: 0 };
  const connection = {
    subscribeMessage(callback, message, options) {
      const pending = deferred();
      requests.push({ message, options, ...pending });
      callbacks.push(callback);
      return pending.promise;
    },
    addEventListener(type, callback) {
      listeners.set(type, callback);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
  };
  const card = {
    _runtimeId: 'tablet-runtime',
    _runtimeClaimed: false,
    config: { satellite_entity: 'assist_satellite.kitchen' },
    connection,
    logger: { log: noop, error: noop },
    pipeline: {},
    start() {
      calls.starts++;
    },
    audio: {
      startMicrophone() {
        calls.mic++;
      },
    },
    recordings: {
      update() {
        calls.recordings++;
      },
    },
    handleRuntimeConflict() {
      calls.conflicts++;
      this._userStopped = true;
      entry.namespace.teardownSatelliteSubscription();
    },
  };
  const resolve = (index) =>
    requests[index].resolve(async () => {
      unsubs.push(index);
    });
  return {
    api: entry.namespace,
    card,
    calls,
    requests,
    resolve,
    listeners,
    timers,
    unsubs,
    context,
  };
}
test('station claim is awaited before any microphone, native detector or recorder starts', async () => {
  const scenario = await fixture();
  const start = scenario.api.startListening(scenario.card);
  await flush();
  assert.equal(scenario.requests.length, 1);
  assert.equal(scenario.requests[0].message.runtime_id, 'tablet-runtime');
  assert.equal(scenario.calls.native + scenario.calls.mic + scenario.calls.recordings, 0);
  scenario.requests[0].reject({ code: 'satellite_in_use', message: 'Use Wake recordings' });
  assert.equal(await start, 'aborted');
  assert.equal(scenario.calls.native + scenario.calls.mic + scenario.calls.recordings, 0);
  assert.equal(scenario.calls.conflicts, 1);
  assert.equal(scenario.card._userStopped, true);
  assert.equal(scenario.timers.size, 0, 'rejection must not retry and fight the tablet');
});
test('same-page callers join one claim; ordinary reconnect retains runtime identity', async () => {
  const scenario = await fixture();
  const first = scenario.api.subscribeSatelliteEvents(scenario.card, noop);
  const second = scenario.api.subscribeSatelliteEvents(scenario.card, noop);
  assert.equal(scenario.requests.length, 1);
  scenario.resolve(0);
  assert.equal(await first, true);
  assert.equal(await second, true);
  scenario.card.isStarted = true;
  scenario.listeners.get('ready')();
  assert.equal(scenario.card._runtimeClaimed, false);
  assert.equal(scenario.requests[1].message.runtime_id, scenario.requests[0].message.runtime_id);
  scenario.resolve(1);
  await flush();
  assert.equal(scenario.card._runtimeClaimed, true);
  assert.deepEqual(scenario.unsubs, [], 'old message ids must not be sent on a reconnected socket');
  scenario.api.teardownSatelliteSubscription();
});
test('late subscribe acknowledgement after Stop is released without reviving runtime', async () => {
  const scenario = await fixture();
  const result = scenario.api.subscribeSatelliteEvents(scenario.card, noop);
  scenario.api.teardownSatelliteSubscription();
  scenario.resolve(0);
  assert.equal(await result, false);
  assert.equal(scenario.card._runtimeClaimed, false);
  assert.equal(scenario.calls.starts, 0);
  assert.deepEqual(scenario.unsubs, [0]);
  assert.equal(scenario.timers.size, 0);
});
test('a stale reconnect acknowledgement cannot replace or unsubscribe the new claim', async () => {
  const scenario = await fixture();
  const old = scenario.api.subscribeSatelliteEvents(scenario.card, noop);
  scenario.listeners.get('ready')();
  scenario.resolve(1);
  await flush();
  scenario.resolve(0);
  assert.equal(await old, false);
  assert.equal(scenario.card._runtimeClaimed, true);
  assert.deepEqual(scenario.unsubs, []);
  scenario.api.teardownSatelliteSubscription();
  assert.deepEqual(scenario.unsubs, [1]);
});
test('HA restart startup failure retries and starts once registration becomes available', async () => {
  const scenario = await fixture();
  const initial = scenario.api.subscribeSatelliteEvents(scenario.card, noop);
  scenario.requests[0].reject({ code: 'unknown_command' });
  assert.equal(await initial, false);
  const retry = [...scenario.timers].find(([, timer]) => timer.delay === 2000);
  scenario.timers.delete(retry[0]);
  retry[1].fn();
  scenario.resolve(1);
  await flush();
  assert.equal(scenario.card._runtimeClaimed, true);
  assert.equal(scenario.calls.starts, 1);
  assert.equal(scenario.calls.conflicts, 0);
  scenario.api.teardownSatelliteSubscription();
});
test('browser auto-start preference is excluded from shared server profiles in both directions', async () => {
  const scenario = await fixture();
  const messages = [];
  const hass = {
    connection: {
      async sendMessagePromise(message) {
        messages.push(message);
        return { exists: true, config: { auto_start: false, skin: 'chat' } };
      },
    },
  };
  const loaded = await scenario.api.loadPanelConfig(hass, 'assist_satellite.kitchen');
  assert.equal(loaded.config.auto_start, undefined);
  assert.equal(loaded.config.skin, 'chat');
  const local = { auto_start: false, skin: 'chat' };
  await scenario.api.savePanelConfig(hass, 'assist_satellite.kitchen', local);
  assert.equal(messages[1].config.auto_start, undefined);
  assert.equal(local.auto_start, false, 'the local browser preference must be preserved');
});
test('opening review cannot resolve an old laptop assignment, hydrate profiles or start its runtime', async () => {
  const scenario = await fixture();
  await scenario.api.attemptStart({}, scenario.card);
  assert.equal(scenario.calls.resolve, 0);
  assert.equal(scenario.calls.starts, 0);
  assert.equal(scenario.requests.length, 0);
  scenario.card.isStarted = true;
  await scenario.api.attemptStart({}, scenario.card);
  assert.equal(scenario.card.isStarted, true, 'navigation must preserve an already-running tablet');
});
test('navigating to review while profile hydration awaits aborts engine startup', async () => {
  const scenario = await fixture();
  const response = deferred();
  scenario.context.window.location.pathname = '/lovelace/0';
  const start = scenario.api.attemptStart(
    { connection: { sendMessagePromise: () => response.promise } },
    scenario.card
  );
  await flush();
  scenario.context.window.location.pathname = '/voice-satellite-recordings';
  response.resolve({ exists: true, config: { skin: 'chat' } });
  await start;
  assert.equal(scenario.calls.resolve, 1);
  assert.equal(scenario.calls.starts, 0);
  assert.equal(scenario.requests.length, 0);
});
test('switching station during initial claim releases old reservation and claims the new selection before capture', async () => {
  const scenario = await fixture();
  const source = readFileSync(path.join(root, 'src/session/index.js'), 'utf8');
  const method = source.slice(source.indexOf('  updateConfig('), source.indexOf('  async start('));
  const updateConfig = vm.runInContext(
    `(${method.trim().replace('updateConfig', 'function')})`,
    scenario.context
  );
  scenario.card._config = scenario.card.config;
  scenario.card._logger = scenario.card.logger;
  scenario.card.teardown = () => {
    scenario.api.teardownSatelliteSubscription();
    scenario.card._starting = false;
    scenario.card._hasStarted = false;
    scenario.card._startAttempted = false;
  };
  const start = scenario.api.startListening(scenario.card);
  await flush();
  updateConfig.call(scenario.card, { satellite_entity: 'assist_satellite.bedroom' });
  assert.equal(
    scenario.card._starting,
    false,
    'changing the selection must invalidate the pending startup'
  );
  scenario.resolve(0);
  await flush();
  assert.deepEqual(scenario.unsubs, [0], 'release late old-station acknowledgement');
  assert.equal(scenario.requests.length, 2);
  assert.equal(scenario.requests[1].message.entity_id, 'assist_satellite.bedroom');
  assert.equal(scenario.card._runtimeClaimed, false);
  assert.equal(scenario.calls.native + scenario.calls.mic + scenario.calls.recordings, 0);
  scenario.requests[1].reject({ code: 'satellite_in_use' });
  assert.equal(await start, 'aborted');
  assert.equal(scenario.calls.native + scenario.calls.mic + scenario.calls.recordings, 0);
  assert.equal(scenario.calls.conflicts, 1);
});
