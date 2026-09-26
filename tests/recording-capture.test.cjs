const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const settle = async () => {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
};
async function fixture({ native = false, api = {}, save } = {}) {
  const calls = [];
  const prompts = [];
  const timers = new Map();
  const events = [];
  let timerId = 0;
  const context = vm.createContext({
    console,
    __VERSION__: 'test',
    crypto: webcrypto,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    setInterval: (fn) => {
      timers.set(++timerId, fn);
      return timerId;
    },
    clearInterval: (id) => timers.delete(id),
    CustomEvent: class {
      constructor(type, options) {
        this.type = type;
        this.detail = options?.detail;
      }
    },
    window: {
      kioskSatellite: api,
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: (e) => events.push(e),
    },
  });
  const review = class {
    constructor() {}
    notify(item) {
      prompts.push(item);
    }
    tick() {}
    clear() {
      prompts.length = 0;
    }
    destroy() {
      this.clear();
    }
  };
  const modules = new Map();
  const exports = { 'src/recordings/review.js': { RecordingReviewPrompt: review } };
  function load(file) {
    if (modules.has(file)) {
      return modules.get(file);
    }
    const name = path.relative(root, file).split(path.sep).join('/');
    const stub = exports[name];
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
      : new vm.SourceTextModule(readFileSync(file, 'utf8'), { context, identifier: file });
    modules.set(file, m);
    return m;
  }
  const module = load(path.join(root, 'src/recordings/index.js'));
  await module.link((specifier, parent) =>
    load(path.resolve(path.dirname(parent.identifier), specifier))
  );
  await module.evaluate();
  const session = {
    config: { satellite_entity: 'assist_satellite.kitchen' },
    _nativeWakeActive: native,
    logger: { log() {} },
    currentState: 'LISTENING',
    wakeWord: {
      getEngine: () => 'oww',
      getModelName: () => 'atlas',
      getThresholdForModel: () => 0.5,
    },
    hass: {
      states: {},
      user: { is_admin: true },
      async callWS(message) {
        calls.push(message);
        if (message.type.endsWith('/config')) {
          return { mode: 'off' };
        }
        if (message.type.endsWith('/save')) {
          return save ? save(message) : { id: message.capture_id, duplicate: false };
        }
      },
    },
  };
  const recorder = new module.namespace.TriggerRecorder(session);
  recorder.entity = session.config.satellite_entity;
  const capture = modules.get(path.join(root, 'src/recordings/capture.js')).namespace;
  return { recorder, capture, session, calls, prompts, timers, events, context };
}
function pcm(wav) {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  return Array.from({ length: (wav.byteLength - 44) / 2 }, (_, i) =>
    view.getInt16(44 + i * 2, true)
  );
}
test('bounded history snapshots the triggering frame, not later microphone audio', async () => {
  const { capture } = await fixture();
  const ring = new capture.PcmCaptureRing(1);
  ring.append(new Float32Array(8000).fill(0.25));
  const trigger = ring.append(new Float32Array(8000).fill(0.5));
  ring.append(new Float32Array(4000).fill(0.75));
  const clip = ring.snapshot(trigger, 0.5);
  assert.equal(clip.count, 8000);
  assert.ok(pcm(clip.wav).every((v) => v === 16384));
  assert.equal(clip.wav.byteLength, 16044);
  assert.equal(new DataView(clip.wav.buffer).getUint32(24, true), 16000);
  assert.equal(clip.discontinuity, false);
  ring.append(new Float32Array(20000));
  assert.equal(
    ring.snapshot(trigger),
    null,
    'expired frame must not capture unrelated newer audio'
  );
});
test('input reuse, resets and skipped inference frames cannot silently corrupt captures', async () => {
  const { capture } = await fixture();
  const ring = new capture.PcmCaptureRing(1);
  const input = new Float32Array([-0.5, 0, 0.5, 1, -1]);
  const marker = ring.append(input);
  input.fill(0);
  assert.deepEqual(pcm(ring.snapshot(marker).wav), [-16384, 0, 16384, 32767, -32768]);
  ring.markGap();
  ring.append(new Float32Array(100));
  assert.equal(ring.snapshot().discontinuity, true);
  ring.reset();
  ring.append(new Float32Array(100));
  assert.equal(ring.snapshot(marker), null, 'old generation is invalid after microphone reset');
  const replacement = new capture.PcmCaptureRing(1);
  replacement.append(new Float32Array(100));
  assert.equal(
    replacement.snapshot(marker),
    null,
    'old frame cannot address a replacement ring after Off/On'
  );
});
test('disabled and muted capture allocates no history or upload', async () => {
  const scenario = await fixture();
  assert.equal(scenario.recorder.feedAudio(new Float32Array(1280)), null);
  assert.equal(scenario.recorder.ring, null);
  await scenario.recorder._applyConfig({ mode: 'save' });
  scenario.session._muted = true;
  assert.equal(scenario.recorder.feedAudio(new Float32Array(1280)), null);
  assert.equal(scenario.recorder.captureDetection({ model: 'atlas', score: 0.9 }, null), null);
  await settle();
  assert.equal(scenario.calls.length, 0);
  scenario.session._muted = false;
  scenario.session.hass.states[scenario.recorder.entity] = { attributes: { muted: true } };
  assert.equal(
    scenario.recorder.feedAudio(new Float32Array(1280)),
    null,
    'HA mute applies before session synchronization'
  );
});
test('save failure retains identical clip for retry; feedback waits for persistence', async () => {
  let fail = true;
  const scenario = await fixture({
    save: async (message) => {
      if (fail) {
        throw new Error('offline');
      }
      return { id: message.capture_id };
    },
  });
  await scenario.recorder._applyConfig({ mode: 'review' });
  const marker = scenario.recorder.feedAudio(new Float32Array(16000).fill(0.125));
  scenario.recorder.captureDetection({ model: 'atlas', score: 0.9 }, marker);
  await settle();
  assert.equal(scenario.recorder.pending.length, 1);
  assert.equal(scenario.prompts.length, 0);
  const first = scenario.calls[0];
  assert.equal(first.metadata.trigger_sample, 16000);
  fail = false;
  await scenario.recorder.flush();
  assert.equal(scenario.recorder.pending.length, 0);
  assert.equal(scenario.calls[1].capture_id, first.capture_id);
  assert.equal(scenario.calls[1].audio_base64, first.audio_base64);
  assert.equal(scenario.prompts.length, 1);
});
test('turning recording off during an upload cannot display delayed feedback', async () => {
  let finish;
  const scenario = await fixture({
    save: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await scenario.recorder._applyConfig({ mode: 'review' });
  const marker = scenario.recorder.feedAudio(new Float32Array(1280));
  scenario.recorder.captureDetection({ model: 'atlas', score: 0.9 }, marker);
  await settle();
  await scenario.recorder._applyConfig({ mode: 'off' });
  finish({ id: 'saved-before-off' });
  await settle();
  assert.equal(scenario.recorder.pending.length, 0);
  assert.equal(scenario.prompts.length, 0);
  assert.equal(scenario.recorder.ring, null);
});
test('native clips are acknowledged only after persistence and acknowledgement retry does not reupload', async () => {
  const order = [];
  let ack = false;
  const api = {
    configureWakeWordRecording: async ({ enabled }) => ({ available: true, enabled }),
    listWakeWordRecordings: async () => ({ items: [] }),
    ackWakeWordRecording: async () => {
      order.push('ack');
      return ack;
    },
  };
  const scenario = await fixture({
    native: true,
    api,
    save: async (m) => {
      order.push('save');
      return { id: m.capture_id };
    },
  });
  await scenario.recorder._applyConfig({ mode: 'save' });
  scenario.recorder._enqueue(
    {
      capture_id: scenario.capture.captureId(),
      audio_base64: 'test',
      metadata: { origin: 'native' },
    },
    true
  );
  await settle();
  assert.deepEqual(order, ['save', 'ack']);
  assert.equal(scenario.recorder.pending.length, 1);
  ack = true;
  await scenario.recorder.flush();
  assert.deepEqual(order, ['save', 'ack', 'ack']);
  assert.equal(scenario.recorder.pending.length, 0);
});
test('older native apps report unavailability instead of pretending to record', async () => {
  const scenario = await fixture({ native: true });
  await scenario.recorder._applyConfig({ mode: 'save' });
  assert.equal(scenario.recorder.getStatus().available, false);
  assert.match(scenario.recorder.getStatus().error, /cannot save native/);
  await assert.rejects(() => scenario.recorder.captureMissed(), /unavailable/);
  assert.equal(scenario.calls.length, 0);
});
test('native configuration retries after a null bridge response without a setting change', async () => {
  const requests = [];
  let bridgeReady = false;
  const scenario = await fixture({
    native: true,
    api: {
      configureWakeWordRecording: async (options) => {
        requests.push(options);
        return bridgeReady ? { available: true, enabled: options.enabled } : null;
      },
      listWakeWordRecordings: async () => ({ items: [] }),
    },
  });
  await scenario.recorder._applyConfig({ mode: 'save' });
  assert.equal(scenario.recorder.getStatus().available, false);
  assert.match(scenario.recorder.getStatus().error, /Retrying automatically/);
  bridgeReady = true;
  await scenario.recorder.syncNative();
  assert.equal(requests.length, 2);
  assert.equal(scenario.recorder.getStatus().available, true);
  assert.equal(scenario.recorder.getStatus().error, null);
  await scenario.recorder.syncNative();
  assert.equal(requests.length, 2, 'Acknowledged settings do not need another request');
});
test('a failed native Off command retries until the app acknowledges the purge', async () => {
  const requests = [];
  let bridgeReady = true;
  const scenario = await fixture({
    native: true,
    api: {
      configureWakeWordRecording: async (options) => {
        requests.push(options);
        return bridgeReady ? { available: true, enabled: options.enabled } : null;
      },
      listWakeWordRecordings: async () => ({ items: [] }),
    },
  });
  await scenario.recorder._applyConfig({ mode: 'save' });
  bridgeReady = false;
  await scenario.recorder._applyConfig({ mode: 'off' });
  bridgeReady = true;
  await scenario.recorder.syncNative();
  assert.deepEqual(
    requests.map((request) => [request.enabled, request.clear_pending]),
    [
      [true, false],
      [false, true],
      [false, true],
    ]
  );
  assert.equal(scenario.recorder.nativeEnabled, false);
  assert.equal(scenario.recorder.getStatus().error, null);
});
test('offline queue is bounded and a missed-wake sample is not labeled automatically', async () => {
  const scenario = await fixture({
    save: async () => {
      throw new Error('offline');
    },
  });
  await scenario.recorder._applyConfig({ mode: 'save' });
  scenario.recorder.feedAudio(new Float32Array(1280));
  for (let i = 0; i < 20; i++) {
    await scenario.recorder.captureMissed();
  }
  await assert.rejects(() => scenario.recorder.captureMissed(), /queue is full/);
  assert.equal(scenario.recorder.pending.length, 20);
  assert.equal(scenario.recorder.dropped, 1);
  assert.equal(scenario.recorder.pending[0].metadata.capture_kind, 'missed');
  assert.equal(scenario.recorder.pending[0].label, undefined);
  assert.equal(scenario.recorder.pending[0].word_present, undefined);
});
const noop = () => {};
async function wakeFixture() {
  const scenario = await fixture();
  await scenario.recorder._applyConfig({ mode: 'save' });
  const context = scenario.context;
  const stubs = {
    'src/audio/chime.js': { CHIME_WAKE: 'wake', getChimeDuration: noop },
    'src/wake-word/micro-models.js': {
      loadTFLite: noop,
      getMicroModelParams: noop,
      resetRuntime: noop,
    },
    'src/wake-word/vww/manifest-cache.js': { getVwwModelParams: noop, loadVwwModelParams: noop },
    'src/wake-word/worker/proxy-backend.js': { WorkerProxyBackend: class {} },
    'src/shared/satellite-notification.js': { clearNotificationUI: noop },
    'src/shared/notification-comms.js': { sendAck: noop },
    'src/kiosk/index.js': {},
  };
  const modules = new Map();
  function load(file) {
    if (modules.has(file)) {
      return modules.get(file);
    }
    const stub = stubs[path.relative(root, file).split(path.sep).join('/')];
    const m = stub
      ? new vm.SyntheticModule(
          Object.keys(stub),
          function () {
            for (const [name, value] of Object.entries(stub)) {
              this.setExport(name, value);
            }
          },
          { context, identifier: file }
        )
      : new vm.SourceTextModule(readFileSync(file, 'utf8'), { context, identifier: file });
    modules.set(file, m);
    return m;
  }
  const m = load(path.join(root, 'src/wake-word/index.js'));
  await m.link((s, parent) => load(path.resolve(path.dirname(parent.identifier), s)));
  await m.evaluate();
  const manager = Object.create(m.namespace.WakeWordManager.prototype);
  const detections = [];
  Object.assign(manager, {
    _active: true,
    _stopOnlyMode: false,
    _processing: false,
    _sampleBuf: new Float32Array(4096),
    _sampleBufLen: 0,
    _frameQueue: [],
    _framePool: [],
    _session: { ...scenario.session, recordings: scenario.recorder },
    _log: {
      log: noop,
      error: (e) => {
        throw new Error(e);
      },
    },
    _onDetection: async (model) => {
      detections.push(model);
    },
    _onStopDetection: async () => {
      detections.push('stop');
    },
  });
  return { ...scenario, manager, detections };
}
test('real inference queue records the triggering frame even when more input arrives during inference', async () => {
  const scenario = await wakeFixture();
  let infer;
  scenario.manager._inference = {
    processChunk: () =>
      new Promise((resolve) => {
        infer = resolve;
      }),
  };
  scenario.manager.feedAudio(new Float32Array(640).fill(0.25));
  scenario.manager.feedAudio(new Float32Array(1280).fill(0.5));
  scenario.manager.feedAudio(new Float32Array(1280).fill(0.75));
  infer({ detected: true, model: 'atlas', score: 0.9 });
  await settle();
  assert.deepEqual(scenario.detections, ['atlas']);
  const saved = scenario.calls.find((c) => c.type.endsWith('/save'));
  assert.equal(saved.metadata.trigger_sample, 1280);
  const samples = pcm(new Uint8Array(Buffer.from(saved.audio_base64, 'base64')));
  assert.deepEqual(samples, [...Array(640).fill(8192), ...Array(640).fill(16384)]);
});
test('real inference overflow tags queued detections and stop-word detections never create recordings', async () => {
  const scenario = await wakeFixture();
  scenario.manager._processing = true;
  scenario.manager._inference = {
    reset: noop,
    processChunk: async () => ({ detected: true, model: 'atlas', score: 0.9 }),
  };
  scenario.manager.feedAudio(new Float32Array(1280 * 55).fill(0.25));
  assert.equal(scenario.manager._frameQueue.length, 50);
  scenario.manager._processing = false;
  await scenario.manager._drainQueue();
  await settle();
  const saved = scenario.calls.find((c) => c.type.endsWith('/save'));
  assert.equal(saved.metadata.discontinuity, true);
  assert.equal(saved.metadata.trigger_sample, 1280 * 6);
  const stop = await wakeFixture();
  stop.manager._stopOnlyMode = true;
  stop.manager._inference = {
    processChunk: async () => ({ detected: true, model: 'stop', score: 0.9 }),
  };
  stop.manager.feedAudio(new Float32Array(1280));
  await settle();
  assert.deepEqual(stop.detections, ['stop']);
  assert.equal(stop.calls.length, 0);
  assert.equal(stop.recorder.ring.total, 0);
});
test('turning Off during native enable is reconciled to disabled and clears pending', async () => {
  const configured = [];
  let finish;
  const api = {
    configureWakeWordRecording: (options) => {
      configured.push(options);
      if (configured.length === 1) {
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
      return Promise.resolve({ available: true, enabled: options.enabled });
    },
    listWakeWordRecordings: async () => ({ items: [] }),
  };
  const scenario = await fixture({ native: true, api });
  const enabling = scenario.recorder._applyConfig({ mode: 'save' });
  await settle();
  await scenario.recorder._applyConfig({ mode: 'off' });
  finish({ available: true, enabled: true });
  await enabling;
  await settle();
  assert.deepEqual(
    configured.map((x) => [x.enabled, x.clear_pending]),
    [
      [true, false],
      [false, true],
    ]
  );
  assert.equal(scenario.recorder.nativeEnabled, false);
  assert.equal(scenario.recorder.getStatus().available, false);
});
test('temporary page teardown preserves native pending clips while changing device clears them', async () => {
  const configured = [];
  const scenario = await fixture({
    native: true,
    api: {
      configureWakeWordRecording: async (options) => {
        configured.push(options);
        return { available: true, enabled: options.enabled };
      },
      listWakeWordRecordings: async () => ({ items: [] }),
    },
  });
  await scenario.recorder._applyConfig({ mode: 'save' });
  scenario.recorder.stop();
  await settle();
  assert.equal(configured.at(-1).enabled, false);
  assert.equal(configured.at(-1).clear_pending, false);
  assert.match(configured.at(-1).owner, /assist_satellite.kitchen$/);
  scenario.recorder.stop(true);
  await settle();
  assert.equal(configured.at(-1).clear_pending, true);
});
