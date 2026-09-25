const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.parentNode = null; this.style = {};
    this.attributes = {}; this.listeners = {}; this._text = ''; this.value = ''; this.disabled = false;
    this.paused = true; this.pauseWhileConnected = [];
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  get isConnected() { return this.tagName === 'body' || !!this.parentNode?.isConnected; }
  appendChild(node) { node.parentNode = this; this.children.push(node); return node; }
  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this);
    this.parentNode = null;
  }
  replaceChildren(...nodes) { this.children.forEach(node => { node.parentNode = null; }); this.children = []; this._text = ''; this.append(...nodes); }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  removeEventListener(type, callback) { if (this.listeners[type] === callback) delete this.listeners[type]; }
  play() { this.paused = false; this.listeners.play?.(); return Promise.resolve(); }
  pause() { this.pauseWhileConnected.push(this.isConnected); this.paused = true; this.listeners.pause?.(); }
  click() { if (!this.disabled) return this.listeners.click?.(); }
  focus() { this.focused = true; }
  checkValidity() { return Number.isInteger(Number(this.value)) && Number(this.value) >= Number(this.min) && Number(this.value) <= Number(this.max); }
  querySelectorAll(selector) {
    const tags = selector.split(',').map(value => value.trim());
    return this.children.flatMap(node => [...(tags.includes(node.tagName) ? [node] : []), ...node.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function find(node, tag, text) { return node.querySelectorAll(tag).find(child => child.textContent === text); }
function wav() { const bytes = Buffer.alloc(44); bytes.write('RIFF'); bytes.write('WAVE', 8); return bytes.toString('base64'); }

async function fixture() {
  let now = 10000;
  const listeners = new Map(), calls = [], revoked = [], created = [], downloads = [];
  const body = new Element('body');
  const window = {
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatchEvent(event) { for (const listener of listeners.get(event.type) || []) listener(event); },
    confirm: () => true,
  };
  const context = vm.createContext({
    console, window, Blob, Uint8Array,
    document: { body, createElement: tag => new Element(tag) },
    Date: class extends Date { static now() { return now; } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    URL: { createObjectURL(blob) { created.push(blob); return `blob:${created.length}`; }, revokeObjectURL(url) { revoked.push(url); } },
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    setTimeout: () => 1, clearTimeout() {},
  });
  const modules = new Map();
  function load(filename) {
    if (!modules.has(filename)) modules.set(filename, new vm.SourceTextModule(readFileSync(filename, 'utf8'), { context, identifier: filename }));
    return modules.get(filename);
  }
  const module = load(path.join(root, 'src/recordings/panel.js'));
  await module.link((specifier, parent) => load(path.resolve(path.dirname(parent.identifier), specifier)));
  await module.evaluate();
  const review = modules.get(path.join(root, 'src/recordings/review.js')).namespace;
  const entity = { value: 'assist_satellite.kitchen' };
  const server = { response: async request => {
    if (request.type.endsWith('/list')) return { items: [], total: 0, config: { mode: 'save', retention_days: 7, max_storage_mb: 250 } };
    return {};
  } };
  const hass = { user: { is_admin: true }, async callWS(request) { calls.push(request); return server.response(request); } };
  const session = { config: { satellite_entity: entity.value }, currentState: 'LISTENING', isStarted: true, tts: { isPlaying: false },
    recordings: { getStatus: () => ({ available: true, mode: 'save', pending: 0, dropped: 0 }), captureMissed: async () => {}, refreshConfig: async () => {} } };
  session.wakeWord = {
    holds: 0, suspends: 0, resumes: 0,
    get isPlaybackSuspended() { return this.holds > 0; },
    suspendForPlayback() { this.holds++; this.suspends++; },
    resumeFromPlayback() { assert.ok(this.holds > 0, 'Playback reference must be balanced'); this.holds--; this.resumes++; },
  };
  const options = { getHass: () => hass, getEntityId: () => entity.value, getSession: () => session };
  const host = new Element('div'); body.appendChild(host);
  const panel = new module.namespace.RecordingsPanel({ ...options, host });
  panel._download = (blob, filename) => downloads.push({ blob, filename });
  const prompt = new review.RecordingReviewPrompt(options);
  session.recordings.review = prompt;
  return { ...module.namespace, ...review, panel, prompt, host, body, entity, session, hass, server, calls, revoked, created, downloads, advance: ms => { now += ms; } };
}

test('feedback waits for TTS and stable idle; explicit feedback does not infer acoustic presence', async () => {
  const f = await fixture();
  f.session.tts.isPlaying = true;
  f.prompt.notify({ id: 'clip-a', entity_id: f.entity.value });
  f.advance(2000); f.prompt.tick();
  assert.equal(f.body.querySelectorAll('section').length, 0);
  f.session.tts.isPlaying = false; f.prompt.tick(); f.advance(750); f.prompt.tick();
  assert.equal(f.body.querySelectorAll('section').length, 1);
  find(f.body, 'button', 'Yes, on purpose').click();
  assert.equal(f.calls.length, 0, 'Intent alone must not label the acoustic contents');
  assert.equal(find(f.body, 'button', 'Save feedback').disabled, true);
  find(f.body, 'button', "I'm not sure").click();
  await find(f.body, 'button', 'Save feedback').click();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].recording_id, 'clip-a');
  assert.equal(f.calls[0].id, undefined, 'HA reserves top-level id');
  assert.equal(f.calls[0].label, 'correct');
  assert.equal(f.calls[0].word_present, 'uncertain');
  assert.equal(f.body.querySelectorAll('section').length, 0);
});

test('skip, timeout, interaction restart, and clear leave clips unreviewed', async () => {
  const f = await fixture();
  for (const action of ['skip', 'timeout', 'busy', 'clear']) {
    f.prompt.notify({ id: action, entity_id: f.entity.value }); f.advance(1100); f.prompt.tick();
    assert.equal(f.body.querySelectorAll('section').length, 1);
    if (action === 'skip') find(f.body, 'button', 'Review later').click();
    if (action === 'timeout') { f.advance(30000); f.prompt.tick(); }
    if (action === 'busy') { f.session.currentState = 'STT'; f.prompt.tick(); f.session.currentState = 'LISTENING'; }
    if (action === 'clear') f.prompt.clear();
    assert.equal(f.body.querySelectorAll('section').length, 0);
  }
  assert.equal(f.calls.length, 0);
});

test('queued feedback is bounded and expires; entity switch removes old prompt', async () => {
  const f = await fixture(); f.session.currentState = 'TTS';
  for (let i = 0; i < 6; i++) f.prompt.notify({ id: `clip-${i}`, entity_id: f.entity.value });
  assert.equal(f.prompt._queue.length, 3);
  f.advance(120001); f.prompt.tick(); assert.equal(f.prompt._queue.length, 0);
  f.session.currentState = 'LISTENING'; f.prompt.notify({ id: 'new', entity_id: f.entity.value });
  f.advance(1100); f.prompt.tick(); assert.equal(f.body.querySelectorAll('section').length, 1);
  f.entity.value = 'assist_satellite.office'; f.prompt.tick();
  assert.equal(f.body.querySelectorAll('section').length, 0);
  assert.equal(f.calls.length, 0);
});

test('delayed upload of an old capture does not produce misleading immediate feedback', async () => {
  const f = await fixture();
  f.prompt.notify({ id: 'old', entity_id: f.entity.value, metadata: { captured_at: new Date(0).toISOString() } });
  f.prompt.clear(); f.advance(120001);
  f.prompt.notify({ id: 'old', entity_id: f.entity.value, metadata: { captured_at: new Date(0).toISOString() } });
  f.advance(1100); f.prompt.tick();
  assert.equal(f.prompt._queue.length, 0);
  assert.equal(f.body.querySelectorAll('section').length, 0);
});

test('feedback also waits for announcements, questions, timers, and follow-up handoff', async () => {
  const f = await fixture();
  for (const manager of ['announcement', 'askQuestion', 'startConversation']) {
    f.session[manager] = { playing: true };
    assert.equal(f.canShowRecordingReview(f.session), false);
    f.session[manager].playing = false;
  }
  f.session.timer = { alertActive: true }; assert.equal(f.canShowRecordingReview(f.session), false);
  f.session.timer.alertActive = false; f.session._followupDelayTimer = 5;
  assert.equal(f.canShowRecordingReview(f.session), false);
  f.session._followupDelayTimer = null; assert.equal(f.canShowRecordingReview(f.session), true);
});

test('feedback request keeps its original entity while a device switch dismisses the prompt', async () => {
  const f = await fixture(); let resolve;
  f.server.response = () => new Promise(done => { resolve = done; });
  f.prompt.notify({ id: 'pending', entity_id: f.entity.value }); f.advance(1100); f.prompt.tick();
  find(f.body, 'button', 'No, accidental wake').click();
  find(f.body, 'button', "I'm not sure").click();
  const request = find(f.body, 'button', 'Save feedback').click();
  f.entity.value = 'assist_satellite.office'; f.prompt.clear(); resolve({}); await request;
  assert.equal(f.calls[0].entity_id, 'assist_satellite.kitchen');
  assert.equal(f.calls[0].word_present, 'uncertain');
  assert.equal(f.body.querySelectorAll('section').length, 0);
});

test('touch feedback supports an accidental wake with the word present and changing intent', async () => {
  const f = await fixture();
  f.prompt.notify({ id: 'tv', entity_id: f.entity.value }); f.advance(1100); f.prompt.tick();
  assert.equal(f.body.querySelectorAll('select').length, 0, 'All choices use direct touch targets');
  find(f.body, 'button', 'Yes, on purpose').click();
  find(f.body, 'button', 'Yes, I heard it').click();
  assert.equal(find(f.body, 'button', 'Yes, I heard it').attributes['aria-pressed'], 'true');
  assert.equal(find(f.body, 'button', 'Yes, I heard it').focused, true, 'Selection keeps keyboard focus in the touch choices');
  find(f.body, 'button', 'Back').click();
  find(f.body, 'button', 'No, accidental wake').click();
  assert.equal(find(f.body, 'button', 'Yes, I heard it').attributes['aria-pressed'], 'true', 'Back preserves the independent presence answer');
  await find(f.body, 'button', 'Save feedback').click();
  assert.equal(f.calls[0].label, 'false_trigger');
  assert.equal(f.calls[0].word_present, 'present', 'Accidental wakes can contain the actual word');
});

test('touch feedback requires explicit presence, preserves answers after failure, and prevents duplicate saves', async () => {
  const f = await fixture(); let reject;
  f.server.response = () => new Promise((_, fail) => { reject = fail; });
  f.prompt.notify({ id: 'retry', entity_id: f.entity.value }); f.advance(1100); f.prompt.tick();
  find(f.body, 'button', 'No, accidental wake').click();
  find(f.body, 'button', 'Save feedback').click();
  assert.equal(f.calls.length, 0);
  find(f.body, 'button', 'No, just other sounds').click();
  const submit = find(f.body, 'button', 'Save feedback');
  const request = submit.click(); submit.click();
  find(f.body, 'button', 'Saving…').click();
  assert.equal(f.calls.length, 1, 'Both stale and visible buttons must reject double taps');
  assert.equal(find(f.body, 'button', 'Back').disabled, true);
  assert.equal(find(f.body, 'button', 'Review later').disabled, true, 'Do not promise to defer a save already in flight');
  f.advance(29000); reject(new Error('Connection lost')); await request;
  f.advance(2000); f.prompt.tick();
  assert.equal(f.body.querySelectorAll('section').length, 1, 'A failed request leaves time to retry');
  assert.match(f.body.textContent, /Your answers are still here/);
  assert.equal(find(f.body, 'button', 'No, just other sounds').attributes['aria-pressed'], 'true');
  assert.equal(find(f.body, 'button', 'Save feedback').focused, true, 'A retry is reachable without losing keyboard position');
  f.server.response = async () => ({});
  await find(f.body, 'button', 'Save feedback').click();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].label, 'false_trigger'); assert.equal(f.calls[1].word_present, 'absent');
  assert.equal(f.body.querySelectorAll('section').length, 0);
});

test('second feedback step remains optional and a new voice turn dismisses it without saving', async () => {
  const f = await fixture();
  for (const action of ['later', 'voice']) {
    f.prompt.notify({ id: action, entity_id: f.entity.value }); f.advance(1100); f.prompt.tick();
    find(f.body, 'button', "I'm not sure").click();
    find(f.body, 'button', 'No, just other sounds').click();
    if (action === 'later') find(f.body, 'button', 'Review later').click();
    else { f.session.currentState = 'STT'; f.prompt.tick(); }
    assert.equal(f.body.querySelectorAll('section').length, 0);
  }
  assert.equal(f.calls.length, 0);
});

test('a late failed save cannot replace feedback for a newer recording', async () => {
  const f = await fixture(); let reject;
  f.server.response = () => new Promise((_, fail) => { reject = fail; });
  f.prompt.notify({ id: 'old', entity_id: f.entity.value }); f.advance(1100); f.prompt.tick();
  find(f.body, 'button', 'Yes, on purpose').click(); find(f.body, 'button', "I'm not sure").click();
  const request = find(f.body, 'button', 'Save feedback').click();
  f.prompt.clear();
  f.prompt.notify({ id: 'new', entity_id: f.entity.value }); f.advance(1100); f.prompt.tick();
  reject(new Error('Old connection failure')); await request;
  assert.equal(f.body.querySelectorAll('section').length, 1);
  assert.ok(find(f.body, 'button', 'Yes, on purpose'), 'New feedback remains on its first step');
  assert.doesNotMatch(f.body.textContent, /Old connection failure/);
});

test('stale entity list response cannot replace the newly selected satellite', async () => {
  const f = await fixture(); const pending = [];
  f.server.response = request => new Promise(resolve => pending.push({ request, resolve }));
  f.panel.mount();
  f.entity.value = 'assist_satellite.office'; f.panel.update();
  const response = id => ({ items: [{ id, created_at: '2026-09-25', label: 'unreviewed' }], total: 1, config: { mode: 'off', retention_days: 7, max_storage_mb: 250 } });
  pending[1].resolve(response('office')); await flush();
  pending[0].resolve(response('kitchen')); await flush();
  assert.equal(f.panel._items[0].id, 'office');
  assert.equal(f.panel._captureButton.disabled, true);
  assert.match(f.panel._captureStatus.textContent, /only on the device/);
});

test('manual missed-wake capture only uses an enabled matching local device', async () => {
  const f = await fixture(); let captures = 0;
  f.session.recordings.captureMissed = async () => { captures++; };
  f.panel.mount(); await flush();
  assert.equal(f.panel._captureButton.disabled, false);
  f.panel._captureButton.click(); await flush(); assert.equal(captures, 1);
  f.session.config.satellite_entity = 'assist_satellite.office'; f.panel.update();
  assert.equal(f.panel._captureButton.disabled, true);
  f.panel._captureButton.click(); assert.equal(captures, 1);
  f.session.config.satellite_entity = f.entity.value; f.panel._config.mode = 'off'; f.panel.update();
  assert.equal(f.panel._captureButton.disabled, true);
});

test('saved label and word presence remain separate, including false wakes with the word present', async () => {
  const f = await fixture(); f.panel.mount(); await flush(); f.calls.length = 0;
  await f.panel._label({ id: 'clip' }, 'false_trigger', 'present');
  const saved = f.calls.find(call => call.type.endsWith('/label'));
  assert.equal(saved.recording_id, 'clip'); assert.equal(saved.id, undefined);
  assert.equal(saved.label, 'false_trigger'); assert.equal(saved.word_present, 'present');
});

test('reviewed export excludes unreviewed and rechecks labels with authenticated get', async () => {
  const f = await fixture(); f.panel.mount(); await flush(); f.calls.length = 0;
  f.panel._items = [{ id: 'yes', label: 'correct' }, { id: 'changed', label: 'false_trigger' }, { id: 'no', label: 'unreviewed' }];
  f.server.response = async request => ({ item: { id: request.recording_id, label: request.recording_id === 'changed' ? 'unreviewed' : 'correct', word_present: 'uncertain', metadata: { session_id: 'source-group' } }, audio_base64: wav() });
  await f.panel._exportReviewedPage();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls.every(call => call.type.endsWith('/get') && call.entity_id === f.entity.value && !('id' in call)), true);
  const exported = JSON.parse(await f.downloads[0].blob.text());
  assert.equal(exported.items.length, 1); assert.equal(exported.items[0].id, 'yes');
  assert.equal(exported.items[0].word_present, 'uncertain'); assert.equal(exported.items[0].audio_base64, wav());
  assert.match(exported.scope, /displayed_page/);
});

test('playback is authenticated, never automatic, and object URLs are revoked on unmount', async () => {
  const f = await fixture(); f.panel.mount(); await flush(); f.calls.length = 0;
  f.server.response = async () => ({ audio_base64: wav(), item: { id: 'clip' } });
  const target = new Element('div'); f.host.appendChild(target);
  await f.panel._play({ id: 'clip' }, target, f.entity.value);
  const player = target.querySelector('audio');
  assert.equal(player.controls, true); assert.equal(player.autoplay, undefined);
  assert.equal(f.calls[0].recording_id, 'clip'); assert.equal(f.calls[0].entity_id, f.entity.value);
  f.panel.destroy(); assert.deepEqual(f.revoked, ['blob:1']);
});

test('late playback response after a satellite change is ignored', async () => {
  const f = await fixture(); f.panel.mount(); await flush(); let resolve;
  f.server.response = () => new Promise(done => { resolve = done; });
  const target = new Element('div'); f.host.appendChild(target);
  const request = f.panel._play({ id: 'clip' }, target, f.entity.value);
  f.entity.value = 'assist_satellite.office'; f.panel._entity = f.entity.value;
  resolve({ audio_base64: wav() }); await request;
  assert.equal(f.created.length, 0);
});

test('review playback suspends the current local microphone even for a remote satellite', async () => {
  const f = await fixture();
  f.entity.value = 'assist_satellite.office';
  f.panel.mount(); await flush();
  f.server.response = async () => ({ audio_base64: wav(), item: { id: 'remote-clip' } });
  const target = new Element('div'); f.host.appendChild(target);
  await f.panel._play({ id: 'remote-clip' }, target, f.entity.value);
  const player = target.querySelector('audio');
  assert.equal(f.session.wakeWord.holds, 0, 'Loading alone must not suspend wake detection');
  const nextWakeWord = { ...f.session.wakeWord };
  const nextSession = { ...f.session, wakeWord: nextWakeWord };
  f.panel._getSession = () => nextSession;
  await player.play();
  assert.equal(f.session.wakeWord.holds, 0, 'Do not retain a session resolved at audio load');
  assert.equal(nextWakeWord.holds, 1, 'Resolve the local microphone when Play is pressed');
  f.panel._getSession = () => f.session;
  player.pause();
  assert.equal(nextWakeWord.holds, 0, 'Release the same manager that acquired the hold');
  assert.equal(f.session.wakeWord.resumes, 0);
  f.panel.destroy();
});

test('repeated play and completion balance one player reference without releasing TTS', async () => {
  const f = await fixture(); f.panel.mount(); await flush();
  f.server.response = async () => ({ audio_base64: wav(), item: { id: 'clip' } });
  const target = new Element('div'); f.host.appendChild(target);
  await f.panel._play({ id: 'clip' }, target, f.entity.value);
  const player = target.querySelector('audio'), wakeWord = f.session.wakeWord;
  wakeWord.suspendForPlayback(); // Independent TTS playback reference.
  await player.play(); player.listeners.play();
  assert.equal(wakeWord.holds, 2, 'Duplicate play events must not add references');
  player.pause(); player.listeners.ended(); player.listeners.error();
  assert.equal(wakeWord.holds, 1, 'Pause/ended/error release our reference exactly once');
  await player.play(); assert.equal(wakeWord.holds, 2);
  f.panel.destroy();
  assert.equal(player.paused, true);
  assert.equal(player.pauseWhileConnected.at(-1), true, 'Pause before removing the audio element');
  assert.equal(wakeWord.holds, 1, 'Unmount must leave the TTS reference intact');
  assert.equal(wakeWord.resumes, 2);
  assert.equal(Object.keys(player.listeners).length, 0);
  wakeWord.resumeFromPlayback(); assert.equal(wakeWord.holds, 0);
});

test('replacement and render stop an existing player and release each hold once', async () => {
  const f = await fixture(); f.panel.mount(); await flush();
  f.server.response = async () => ({ audio_base64: wav(), item: { id: 'clip' } });
  const target = new Element('div'); f.host.appendChild(target);
  await f.panel._play({ id: 'clip' }, target, f.entity.value);
  const old = target.querySelector('audio'); await old.play();
  const stalePlayEvent = old.listeners.play;
  await f.panel._play({ id: 'replacement' }, target, f.entity.value);
  assert.equal(old.paused, true); assert.equal(old.pauseWhileConnected.at(-1), true);
  assert.equal(f.session.wakeWord.holds, 0); assert.equal(f.session.wakeWord.resumes, 1);
  stalePlayEvent(); assert.equal(f.session.wakeWord.holds, 0, 'A late event on a disposed player cannot reacquire');
  const next = target.querySelector('audio'); await next.play();
  f.panel._render();
  assert.equal(next.paused, true); assert.equal(next.pauseWhileConnected.at(-1), true);
  assert.equal(f.session.wakeWord.holds, 0); assert.equal(f.session.wakeWord.resumes, 2);
  assert.deepEqual(f.revoked, ['blob:1', 'blob:2']);
});

test('playing a reviewed clip dismisses and blocks feedback until playback finishes', async () => {
  const f = await fixture(); f.panel.mount(); await flush();
  f.prompt.notify({ id: 'prompt', entity_id: f.entity.value }); f.advance(1100); f.prompt.tick();
  assert.equal(f.body.querySelectorAll('section').length, 1);
  f.server.response = async () => ({ audio_base64: wav(), item: { id: 'clip' } });
  const target = new Element('div'); f.host.appendChild(target);
  await f.panel._play({ id: 'clip' }, target, f.entity.value);
  const player = target.querySelector('audio'); await player.play();
  assert.equal(f.body.querySelectorAll('section').length, 0);
  assert.equal(f.canShowRecordingReview(f.session), false);
  player.paused = true; player.listeners.ended();
  assert.equal(f.session.wakeWord.holds, 0);
  assert.equal(f.canShowRecordingReview(f.session), true);
  assert.equal(f.calls.some(call => call.type.endsWith('/label')), false);
  f.panel.destroy();
});

test('audio errors release suspension and failed replacement pauses the old clip', async () => {
  const f = await fixture(); f.panel.mount(); await flush();
  f.server.response = async () => ({ audio_base64: wav(), item: { id: 'clip' } });
  const target = new Element('div'); f.host.appendChild(target);
  await f.panel._play({ id: 'clip' }, target, f.entity.value);
  const player = target.querySelector('audio'); await player.play();
  player.listeners.error(); player.listeners.error();
  assert.equal(f.session.wakeWord.holds, 0); assert.equal(f.session.wakeWord.resumes, 1);
  await player.play();
  f.server.response = async () => { throw new Error('Connection lost'); };
  await f.panel._play({ id: 'replacement' }, target, f.entity.value);
  assert.equal(player.paused, true); assert.equal(player.pauseWhileConnected.at(-1), true);
  assert.equal(f.session.wakeWord.holds, 0); assert.equal(f.session.wakeWord.resumes, 2);
  assert.match(target.textContent, /Connection lost/);
  f.panel.destroy();
});

test('non-admin review cannot list or configure audio; invalid audio is rejected', async () => {
  const f = await fixture(); f.hass.user.is_admin = false; f.panel.mount(); await flush();
  assert.equal(f.calls.length, 0); assert.match(f.host.textContent, /administrator/);
  assert.throws(() => f.recordingBlob('abc'), /WAV/);
  assert.throws(() => f.recordingBlob('a'.repeat(430001)), /oversized/);
  assert.equal(f.recordingFilename('../../clip<script>'), 'wake-______clip_script_.wav');
});
