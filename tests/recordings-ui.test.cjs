const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const flush = async () => {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
};
class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.attributes = {};
    this.listeners = {};
    this._text = '';
    this.value = '';
    this.disabled = false;
    this.paused = true;
    this.pauseWhileConnected = [];
  }
  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }
  get textContent() {
    return this._text + this.children.map((node) => node.textContent).join('');
  }
  get isConnected() {
    return this.tagName === 'body' || !!this.parentNode?.isConnected;
  }
  appendChild(node) {
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  append(...nodes) {
    nodes.forEach((node) => this.appendChild(node));
  }
  remove() {
    if (this.parentNode) {
      this.parentNode.children = this.parentNode.children.filter((node) => node !== this);
    }
    this.parentNode = null;
  }
  replaceChildren(...nodes) {
    this.children.forEach((node) => {
      node.parentNode = null;
    });
    this.children = [];
    this._text = '';
    this.append(...nodes);
  }
  setAttribute(key, value) {
    this.attributes[key] = value;
  }
  addEventListener(type, callback) {
    this.listeners[type] = callback;
  }
  removeEventListener(type, callback) {
    if (this.listeners[type] === callback) {
      delete this.listeners[type];
    }
  }
  play() {
    this.paused = false;
    this.listeners.play?.();
    return Promise.resolve();
  }
  pause() {
    this.pauseWhileConnected.push(this.isConnected);
    this.paused = true;
    this.listeners.pause?.();
  }
  click() {
    if (!this.disabled) {
      return this.listeners.click?.();
    }
  }
  focus() {
    this.focused = true;
  }
  checkValidity() {
    return (
      Number.isInteger(Number(this.value)) &&
      Number(this.value) >= Number(this.min) &&
      Number(this.value) <= Number(this.max)
    );
  }
  querySelectorAll(selector) {
    const tags = selector.split(',').map((value) => value.trim());
    return this.children.flatMap((node) => [
      ...(tags.includes(node.tagName) ? [node] : []),
      ...node.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}
function find(node, tag, text) {
  return node.querySelectorAll(tag).find((child) => child.textContent === text);
}
function wav() {
  const bytes = Buffer.alloc(44);
  bytes.write('RIFF');
  bytes.write('WAVE', 8);
  return bytes.toString('base64');
}
async function fixture() {
  let now = 10000;
  const listeners = new Map();
  const calls = [];
  const revoked = [];
  const created = [];
  const downloads = [];
  const body = new Element('body');
  const window = {
    addEventListener(type, listener) {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) {
        listener(event);
      }
    },
    confirm: () => true,
  };
  const context = vm.createContext({
    console,
    window,
    Blob,
    Uint8Array,
    document: { body, createElement: (tag) => new Element(tag) },
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    CustomEvent: class {
      constructor(type, init) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    URL: {
      createObjectURL(blob) {
        created.push(blob);
        return `blob:${created.length}`;
      },
      revokeObjectURL(url) {
        revoked.push(url);
      },
    },
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    setTimeout: () => 1,
    clearTimeout() {},
  });
  const modules = new Map();
  function load(filename) {
    if (!modules.has(filename)) {
      modules.set(
        filename,
        new vm.SourceTextModule(readFileSync(filename, 'utf8'), { context, identifier: filename })
      );
    }
    return modules.get(filename);
  }
  const module = load(path.join(root, 'src/recordings/panel.js'));
  await module.link((specifier, parent) =>
    load(path.resolve(path.dirname(parent.identifier), specifier))
  );
  await module.evaluate();
  const review = modules.get(path.join(root, 'src/recordings/review.js')).namespace;
  const entity = { value: 'assist_satellite.kitchen' };
  const server = {
    response: async (request) => {
      if (request.type.endsWith('/list')) {
        return {
          items: [],
          total: 0,
          config: { mode: 'save', retention_days: 7, max_storage_mb: 250 },
        };
      }
      return {};
    },
  };
  const hass = {
    user: { is_admin: true },
    async callWS(request) {
      calls.push(request);
      return server.response(request);
    },
  };
  const session = {
    config: { satellite_entity: entity.value },
    currentState: 'LISTENING',
    isStarted: true,
    tts: { isPlaying: false },
    recordings: {
      getStatus: () => ({ available: true, mode: 'save', pending: 0, dropped: 0 }),
      captureMissed: async () => {},
      refreshConfig: async () => {},
    },
  };
  session.wakeWord = {
    holds: 0,
    suspends: 0,
    resumes: 0,
    get isPlaybackSuspended() {
      return this.holds > 0;
    },
    suspendForPlayback() {
      this.holds++;
      this.suspends++;
    },
    resumeFromPlayback() {
      assert.ok(this.holds > 0, 'Playback reference must be balanced');
      this.holds--;
      this.resumes++;
    },
  };
  const options = {
    getHass: () => hass,
    getEntityId: () => entity.value,
    getSession: () => session,
  };
  const host = new Element('div');
  body.appendChild(host);
  const panel = new module.namespace.RecordingsPanel({ ...options, host });
  panel._download = (blob, filename) => downloads.push({ blob, filename });
  const prompt = new review.RecordingReviewPrompt(options);
  session.recordings.review = prompt;
  return {
    ...module.namespace,
    ...review,
    panel,
    prompt,
    host,
    body,
    entity,
    session,
    hass,
    server,
    calls,
    revoked,
    created,
    downloads,
    advance: (ms) => {
      now += ms;
    },
  };
}
test('feedback waits for TTS and stable idle; explicit feedback does not infer acoustic presence', async () => {
  const scenario = await fixture();
  scenario.session.tts.isPlaying = true;
  scenario.prompt.notify({ id: 'clip-a', entity_id: scenario.entity.value });
  scenario.advance(2000);
  scenario.prompt.tick();
  assert.equal(scenario.body.querySelectorAll('section').length, 0);
  scenario.session.tts.isPlaying = false;
  scenario.prompt.tick();
  scenario.advance(750);
  scenario.prompt.tick();
  assert.equal(scenario.body.querySelectorAll('section').length, 1);
  find(scenario.body, 'button', 'Yes, on purpose').click();
  assert.equal(scenario.calls.length, 0, 'Intent alone must not label the acoustic contents');
  assert.equal(find(scenario.body, 'button', 'Save feedback').disabled, true);
  find(scenario.body, 'button', "I'm not sure").click();
  await find(scenario.body, 'button', 'Save feedback').click();
  assert.equal(scenario.calls.length, 1);
  assert.equal(scenario.calls[0].recording_id, 'clip-a');
  assert.equal(scenario.calls[0].id, undefined, 'HA reserves top-level id');
  assert.equal(scenario.calls[0].label, 'correct');
  assert.equal(scenario.calls[0].word_present, 'uncertain');
  assert.equal(scenario.body.querySelectorAll('section').length, 0);
});
test('skip, timeout, interaction restart, and clear leave clips unreviewed', async () => {
  const scenario = await fixture();
  for (const action of ['skip', 'timeout', 'busy', 'clear']) {
    scenario.prompt.notify({ id: action, entity_id: scenario.entity.value });
    scenario.advance(1100);
    scenario.prompt.tick();
    assert.equal(scenario.body.querySelectorAll('section').length, 1);
    if (action === 'skip') {
      find(scenario.body, 'button', 'Review later').click();
    }
    if (action === 'timeout') {
      scenario.advance(30000);
      scenario.prompt.tick();
    }
    if (action === 'busy') {
      scenario.session.currentState = 'STT';
      scenario.prompt.tick();
      scenario.session.currentState = 'LISTENING';
    }
    if (action === 'clear') {
      scenario.prompt.clear();
    }
    assert.equal(scenario.body.querySelectorAll('section').length, 0);
  }
  assert.equal(scenario.calls.length, 0);
});
test('queued feedback is bounded and expires; entity switch removes old prompt', async () => {
  const scenario = await fixture();
  scenario.session.currentState = 'TTS';
  for (let i = 0; i < 6; i++) {
    scenario.prompt.notify({ id: `clip-${i}`, entity_id: scenario.entity.value });
  }
  assert.equal(scenario.prompt._queue.length, 3);
  scenario.advance(120001);
  scenario.prompt.tick();
  assert.equal(scenario.prompt._queue.length, 0);
  scenario.session.currentState = 'LISTENING';
  scenario.prompt.notify({ id: 'new', entity_id: scenario.entity.value });
  scenario.advance(1100);
  scenario.prompt.tick();
  assert.equal(scenario.body.querySelectorAll('section').length, 1);
  scenario.entity.value = 'assist_satellite.office';
  scenario.prompt.tick();
  assert.equal(scenario.body.querySelectorAll('section').length, 0);
  assert.equal(scenario.calls.length, 0);
});
test('delayed upload of an old capture does not produce misleading immediate feedback', async () => {
  const scenario = await fixture();
  scenario.prompt.notify({
    id: 'old',
    entity_id: scenario.entity.value,
    metadata: { captured_at: new Date(0).toISOString() },
  });
  scenario.prompt.clear();
  scenario.advance(120001);
  scenario.prompt.notify({
    id: 'old',
    entity_id: scenario.entity.value,
    metadata: { captured_at: new Date(0).toISOString() },
  });
  scenario.advance(1100);
  scenario.prompt.tick();
  assert.equal(scenario.prompt._queue.length, 0);
  assert.equal(scenario.body.querySelectorAll('section').length, 0);
});
test('feedback also waits for announcements, questions, timers, and follow-up handoff', async () => {
  const scenario = await fixture();
  for (const manager of ['announcement', 'askQuestion', 'startConversation']) {
    scenario.session[manager] = { playing: true };
    assert.equal(scenario.canShowRecordingReview(scenario.session), false);
    scenario.session[manager].playing = false;
  }
  scenario.session.timer = { alertActive: true };
  assert.equal(scenario.canShowRecordingReview(scenario.session), false);
  scenario.session.timer.alertActive = false;
  scenario.session._followupDelayTimer = 5;
  assert.equal(scenario.canShowRecordingReview(scenario.session), false);
  scenario.session._followupDelayTimer = null;
  assert.equal(scenario.canShowRecordingReview(scenario.session), true);
});
test('feedback request keeps its original entity while a device switch dismisses the prompt', async () => {
  const scenario = await fixture();
  let resolve;
  scenario.server.response = () =>
    new Promise((done) => {
      resolve = done;
    });
  scenario.prompt.notify({ id: 'pending', entity_id: scenario.entity.value });
  scenario.advance(1100);
  scenario.prompt.tick();
  find(scenario.body, 'button', 'No, accidental wake').click();
  find(scenario.body, 'button', "I'm not sure").click();
  const request = find(scenario.body, 'button', 'Save feedback').click();
  scenario.entity.value = 'assist_satellite.office';
  scenario.prompt.clear();
  resolve({});
  await request;
  assert.equal(scenario.calls[0].entity_id, 'assist_satellite.kitchen');
  assert.equal(scenario.calls[0].word_present, 'uncertain');
  assert.equal(scenario.body.querySelectorAll('section').length, 0);
});
test('touch feedback supports an accidental wake with the word present and changing intent', async () => {
  const scenario = await fixture();
  scenario.prompt.notify({ id: 'tv', entity_id: scenario.entity.value });
  scenario.advance(1100);
  scenario.prompt.tick();
  assert.equal(
    scenario.body.querySelectorAll('select').length,
    0,
    'All choices use direct touch targets'
  );
  find(scenario.body, 'button', 'Yes, on purpose').click();
  find(scenario.body, 'button', 'Yes, I heard it').click();
  assert.equal(find(scenario.body, 'button', 'Yes, I heard it').attributes['aria-pressed'], 'true');
  assert.equal(
    find(scenario.body, 'button', 'Yes, I heard it').focused,
    true,
    'Selection keeps keyboard focus in the touch choices'
  );
  find(scenario.body, 'button', 'Back').click();
  find(scenario.body, 'button', 'No, accidental wake').click();
  assert.equal(
    find(scenario.body, 'button', 'Yes, I heard it').attributes['aria-pressed'],
    'true',
    'Back preserves the independent presence answer'
  );
  await find(scenario.body, 'button', 'Save feedback').click();
  assert.equal(scenario.calls[0].label, 'false_trigger');
  assert.equal(
    scenario.calls[0].word_present,
    'present',
    'Accidental wakes can contain the actual word'
  );
});
test('touch feedback requires explicit presence, preserves answers after failure, and prevents duplicate saves', async () => {
  const scenario = await fixture();
  let reject;
  scenario.server.response = () =>
    new Promise((_, fail) => {
      reject = fail;
    });
  scenario.prompt.notify({ id: 'retry', entity_id: scenario.entity.value });
  scenario.advance(1100);
  scenario.prompt.tick();
  find(scenario.body, 'button', 'No, accidental wake').click();
  find(scenario.body, 'button', 'Save feedback').click();
  assert.equal(scenario.calls.length, 0);
  find(scenario.body, 'button', 'No, just other sounds').click();
  const submit = find(scenario.body, 'button', 'Save feedback');
  const request = submit.click();
  submit.click();
  find(scenario.body, 'button', 'Saving…').click();
  assert.equal(scenario.calls.length, 1, 'Both stale and visible buttons must reject double taps');
  assert.equal(find(scenario.body, 'button', 'Back').disabled, true);
  assert.equal(
    find(scenario.body, 'button', 'Review later').disabled,
    true,
    'Do not promise to defer a save already in flight'
  );
  scenario.advance(29000);
  reject(new Error('Connection lost'));
  await request;
  scenario.advance(2000);
  scenario.prompt.tick();
  assert.equal(
    scenario.body.querySelectorAll('section').length,
    1,
    'A failed request leaves time to retry'
  );
  assert.match(scenario.body.textContent, /Your answers are still here/);
  assert.equal(
    find(scenario.body, 'button', 'No, just other sounds').attributes['aria-pressed'],
    'true'
  );
  assert.equal(
    find(scenario.body, 'button', 'Save feedback').focused,
    true,
    'A retry is reachable without losing keyboard position'
  );
  scenario.server.response = async () => ({});
  await find(scenario.body, 'button', 'Save feedback').click();
  assert.equal(scenario.calls.length, 2);
  assert.equal(scenario.calls[1].label, 'false_trigger');
  assert.equal(scenario.calls[1].word_present, 'absent');
  assert.equal(scenario.body.querySelectorAll('section').length, 0);
});
test('second feedback step remains optional and a new voice turn dismisses it without saving', async () => {
  const scenario = await fixture();
  for (const action of ['later', 'voice']) {
    scenario.prompt.notify({ id: action, entity_id: scenario.entity.value });
    scenario.advance(1100);
    scenario.prompt.tick();
    find(scenario.body, 'button', "I'm not sure").click();
    find(scenario.body, 'button', 'No, just other sounds').click();
    if (action === 'later') {
      find(scenario.body, 'button', 'Review later').click();
    } else {
      scenario.session.currentState = 'STT';
      scenario.prompt.tick();
    }
    assert.equal(scenario.body.querySelectorAll('section').length, 0);
  }
  assert.equal(scenario.calls.length, 0);
});
test('a late failed save cannot replace feedback for a newer recording', async () => {
  const scenario = await fixture();
  let reject;
  scenario.server.response = () =>
    new Promise((_, fail) => {
      reject = fail;
    });
  scenario.prompt.notify({ id: 'old', entity_id: scenario.entity.value });
  scenario.advance(1100);
  scenario.prompt.tick();
  find(scenario.body, 'button', 'Yes, on purpose').click();
  find(scenario.body, 'button', "I'm not sure").click();
  const request = find(scenario.body, 'button', 'Save feedback').click();
  scenario.prompt.clear();
  scenario.prompt.notify({ id: 'new', entity_id: scenario.entity.value });
  scenario.advance(1100);
  scenario.prompt.tick();
  reject(new Error('Old connection failure'));
  await request;
  assert.equal(scenario.body.querySelectorAll('section').length, 1);
  assert.ok(
    find(scenario.body, 'button', 'Yes, on purpose'),
    'New feedback remains on its first step'
  );
  assert.doesNotMatch(scenario.body.textContent, /Old connection failure/);
});
test('stale entity list response cannot replace the newly selected satellite', async () => {
  const scenario = await fixture();
  const pending = [];
  scenario.server.response = (request) =>
    new Promise((resolve) => pending.push({ request, resolve }));
  scenario.panel.mount();
  scenario.entity.value = 'assist_satellite.office';
  scenario.panel.update();
  const response = (id) => ({
    items: [{ id, created_at: '2026-09-25', label: 'unreviewed' }],
    total: 1,
    config: { mode: 'off', retention_days: 7, max_storage_mb: 250 },
  });
  pending[1].resolve(response('office'));
  await flush();
  pending[0].resolve(response('kitchen'));
  await flush();
  assert.equal(scenario.panel._items[0].id, 'office');
  assert.equal(scenario.panel._captureButton.disabled, true);
  assert.match(scenario.panel._captureStatus.textContent, /only on the device/);
});
test('manual missed-wake capture only uses an enabled matching local device', async () => {
  const scenario = await fixture();
  let captures = 0;
  scenario.session.recordings.captureMissed = async () => {
    captures++;
  };
  scenario.panel.mount();
  await flush();
  assert.equal(scenario.panel._captureButton.disabled, false);
  scenario.panel._captureButton.click();
  await flush();
  assert.equal(captures, 1);
  scenario.session.config.satellite_entity = 'assist_satellite.office';
  scenario.panel.update();
  assert.equal(scenario.panel._captureButton.disabled, true);
  scenario.panel._captureButton.click();
  assert.equal(captures, 1);
  scenario.session.config.satellite_entity = scenario.entity.value;
  scenario.panel._config.mode = 'off';
  scenario.panel.update();
  assert.equal(scenario.panel._captureButton.disabled, true);
});
test('saved label and word presence remain separate, including false wakes with the word present', async () => {
  const scenario = await fixture();
  scenario.panel.mount();
  await flush();
  scenario.calls.length = 0;
  await scenario.panel._label({ id: 'clip' }, 'false_trigger', 'present');
  const saved = scenario.calls.find((call) => call.type.endsWith('/label'));
  assert.equal(saved.recording_id, 'clip');
  assert.equal(saved.id, undefined);
  assert.equal(saved.label, 'false_trigger');
  assert.equal(saved.word_present, 'present');
});
test('reviewed export excludes unreviewed and rechecks labels with authenticated get', async () => {
  const scenario = await fixture();
  scenario.panel.mount();
  await flush();
  scenario.calls.length = 0;
  scenario.panel._items = [
    { id: 'yes', label: 'correct' },
    { id: 'changed', label: 'false_trigger' },
    { id: 'no', label: 'unreviewed' },
  ];
  scenario.server.response = async (request) => ({
    item: {
      id: request.recording_id,
      label: request.recording_id === 'changed' ? 'unreviewed' : 'correct',
      word_present: 'uncertain',
      metadata: { session_id: 'source-group' },
    },
    audio_base64: wav(),
  });
  await scenario.panel._exportReviewedPage();
  assert.equal(scenario.calls.length, 2);
  assert.equal(
    scenario.calls.every(
      (call) =>
        call.type.endsWith('/get') && call.entity_id === scenario.entity.value && !('id' in call)
    ),
    true
  );
  const exported = JSON.parse(await scenario.downloads[0].blob.text());
  assert.equal(exported.items.length, 1);
  assert.equal(exported.items[0].id, 'yes');
  assert.equal(exported.items[0].word_present, 'uncertain');
  assert.equal(exported.items[0].audio_base64, wav());
  assert.match(exported.scope, /displayed_page/);
});
test('playback is authenticated, never automatic, and object URLs are revoked on unmount', async () => {
  const scenario = await fixture();
  scenario.panel.mount();
  await flush();
  scenario.calls.length = 0;
  scenario.server.response = async () => ({ audio_base64: wav(), item: { id: 'clip' } });
  const target = new Element('div');
  scenario.host.appendChild(target);
  await scenario.panel._play({ id: 'clip' }, target, scenario.entity.value);
  const player = target.querySelector('audio');
  assert.equal(player.controls, true);
  assert.equal(player.autoplay, undefined);
  assert.equal(scenario.calls[0].recording_id, 'clip');
  assert.equal(scenario.calls[0].entity_id, scenario.entity.value);
  scenario.panel.destroy();
  assert.deepEqual(scenario.revoked, ['blob:1']);
});
test('late playback response after a satellite change is ignored', async () => {
  const scenario = await fixture();
  scenario.panel.mount();
  await flush();
  let resolve;
  scenario.server.response = () =>
    new Promise((done) => {
      resolve = done;
    });
  const target = new Element('div');
  scenario.host.appendChild(target);
  const request = scenario.panel._play({ id: 'clip' }, target, scenario.entity.value);
  scenario.entity.value = 'assist_satellite.office';
  scenario.panel._entity = scenario.entity.value;
  resolve({ audio_base64: wav() });
  await request;
  assert.equal(scenario.created.length, 0);
});
test('review playback suspends the current local microphone even for a remote satellite', async () => {
  const scenario = await fixture();
  scenario.entity.value = 'assist_satellite.office';
  scenario.panel.mount();
  await flush();
  scenario.server.response = async () => ({ audio_base64: wav(), item: { id: 'remote-clip' } });
  const target = new Element('div');
  scenario.host.appendChild(target);
  await scenario.panel._play({ id: 'remote-clip' }, target, scenario.entity.value);
  const player = target.querySelector('audio');
  assert.equal(scenario.session.wakeWord.holds, 0, 'Loading alone must not suspend wake detection');
  const nextWakeWord = { ...scenario.session.wakeWord };
  const nextSession = { ...scenario.session, wakeWord: nextWakeWord };
  scenario.panel._getSession = () => nextSession;
  await player.play();
  assert.equal(
    scenario.session.wakeWord.holds,
    0,
    'Do not retain a session resolved at audio load'
  );
  assert.equal(nextWakeWord.holds, 1, 'Resolve the local microphone when Play is pressed');
  scenario.panel._getSession = () => scenario.session;
  player.pause();
  assert.equal(nextWakeWord.holds, 0, 'Release the same manager that acquired the hold');
  assert.equal(scenario.session.wakeWord.resumes, 0);
  scenario.panel.destroy();
});
test('repeated play and completion balance one player reference without releasing TTS', async () => {
  const scenario = await fixture();
  scenario.panel.mount();
  await flush();
  scenario.server.response = async () => ({ audio_base64: wav(), item: { id: 'clip' } });
  const target = new Element('div');
  scenario.host.appendChild(target);
  await scenario.panel._play({ id: 'clip' }, target, scenario.entity.value);
  const player = target.querySelector('audio');
  const wakeWord = scenario.session.wakeWord;
  wakeWord.suspendForPlayback(); // Independent TTS playback reference.
  await player.play();
  player.listeners.play();
  assert.equal(wakeWord.holds, 2, 'Duplicate play events must not add references');
  player.pause();
  player.listeners.ended();
  player.listeners.error();
  assert.equal(wakeWord.holds, 1, 'Pause/ended/error release our reference exactly once');
  await player.play();
  assert.equal(wakeWord.holds, 2);
  scenario.panel.destroy();
  assert.equal(player.paused, true);
  assert.equal(player.pauseWhileConnected.at(-1), true, 'Pause before removing the audio element');
  assert.equal(wakeWord.holds, 1, 'Unmount must leave the TTS reference intact');
  assert.equal(wakeWord.resumes, 2);
  assert.equal(Object.keys(player.listeners).length, 0);
  wakeWord.resumeFromPlayback();
  assert.equal(wakeWord.holds, 0);
});
test('replacement and render stop an existing player and release each hold once', async () => {
  const scenario = await fixture();
  scenario.panel.mount();
  await flush();
  scenario.server.response = async () => ({ audio_base64: wav(), item: { id: 'clip' } });
  const target = new Element('div');
  scenario.host.appendChild(target);
  await scenario.panel._play({ id: 'clip' }, target, scenario.entity.value);
  const old = target.querySelector('audio');
  await old.play();
  const stalePlayEvent = old.listeners.play;
  await scenario.panel._play({ id: 'replacement' }, target, scenario.entity.value);
  assert.equal(old.paused, true);
  assert.equal(old.pauseWhileConnected.at(-1), true);
  assert.equal(scenario.session.wakeWord.holds, 0);
  assert.equal(scenario.session.wakeWord.resumes, 1);
  stalePlayEvent();
  assert.equal(
    scenario.session.wakeWord.holds,
    0,
    'A late event on a disposed player cannot reacquire'
  );
  const next = target.querySelector('audio');
  await next.play();
  scenario.panel._render();
  assert.equal(next.paused, true);
  assert.equal(next.pauseWhileConnected.at(-1), true);
  assert.equal(scenario.session.wakeWord.holds, 0);
  assert.equal(scenario.session.wakeWord.resumes, 2);
  assert.deepEqual(scenario.revoked, ['blob:1', 'blob:2']);
});
test('playing a reviewed clip dismisses and blocks feedback until playback finishes', async () => {
  const scenario = await fixture();
  scenario.panel.mount();
  await flush();
  scenario.prompt.notify({ id: 'prompt', entity_id: scenario.entity.value });
  scenario.advance(1100);
  scenario.prompt.tick();
  assert.equal(scenario.body.querySelectorAll('section').length, 1);
  scenario.server.response = async () => ({ audio_base64: wav(), item: { id: 'clip' } });
  const target = new Element('div');
  scenario.host.appendChild(target);
  await scenario.panel._play({ id: 'clip' }, target, scenario.entity.value);
  const player = target.querySelector('audio');
  await player.play();
  assert.equal(scenario.body.querySelectorAll('section').length, 0);
  assert.equal(scenario.canShowRecordingReview(scenario.session), false);
  player.paused = true;
  player.listeners.ended();
  assert.equal(scenario.session.wakeWord.holds, 0);
  assert.equal(scenario.canShowRecordingReview(scenario.session), true);
  assert.equal(
    scenario.calls.some((call) => call.type.endsWith('/label')),
    false
  );
  scenario.panel.destroy();
});
test('audio errors release suspension and failed replacement pauses the old clip', async () => {
  const scenario = await fixture();
  scenario.panel.mount();
  await flush();
  scenario.server.response = async () => ({ audio_base64: wav(), item: { id: 'clip' } });
  const target = new Element('div');
  scenario.host.appendChild(target);
  await scenario.panel._play({ id: 'clip' }, target, scenario.entity.value);
  const player = target.querySelector('audio');
  await player.play();
  player.listeners.error();
  player.listeners.error();
  assert.equal(scenario.session.wakeWord.holds, 0);
  assert.equal(scenario.session.wakeWord.resumes, 1);
  await player.play();
  scenario.server.response = async () => {
    throw new Error('Connection lost');
  };
  await scenario.panel._play({ id: 'replacement' }, target, scenario.entity.value);
  assert.equal(player.paused, true);
  assert.equal(player.pauseWhileConnected.at(-1), true);
  assert.equal(scenario.session.wakeWord.holds, 0);
  assert.equal(scenario.session.wakeWord.resumes, 2);
  assert.match(target.textContent, /Connection lost/);
  scenario.panel.destroy();
});
test('non-admin review cannot list or configure audio; invalid audio is rejected', async () => {
  const scenario = await fixture();
  scenario.hass.user.is_admin = false;
  scenario.panel.mount();
  await flush();
  assert.equal(scenario.calls.length, 0);
  assert.match(scenario.host.textContent, /administrator/);
  assert.throws(() => scenario.recordingBlob('abc'), /WAV/);
  assert.throws(() => scenario.recordingBlob('a'.repeat(430001)), /oversized/);
  assert.equal(scenario.recordingFilename('../../clip<script>'), 'wake-______clip_script_.wav');
});
