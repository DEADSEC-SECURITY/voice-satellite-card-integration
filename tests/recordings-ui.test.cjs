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
  click() { if (!this.disabled) return this.listeners.click?.(); }
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
  const options = { getHass: () => hass, getEntityId: () => entity.value, getSession: () => session };
  const host = new Element('div'); body.appendChild(host);
  const panel = new module.namespace.RecordingsPanel({ ...options, host });
  panel._download = (blob, filename) => downloads.push({ blob, filename });
  const prompt = new review.RecordingReviewPrompt(options);
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
  await find(f.body, 'button', 'Correct wake').click();
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
    if (action === 'skip') find(f.body, 'button', 'Skip').click();
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
  const request = find(f.body, 'button', 'False wake').click();
  f.entity.value = 'assist_satellite.office'; f.prompt.clear(); resolve({}); await request;
  assert.equal(f.calls[0].entity_id, 'assist_satellite.kitchen');
  assert.equal(f.calls[0].word_present, 'uncertain');
  assert.equal(f.body.querySelectorAll('section').length, 0);
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

test('non-admin review cannot list or configure audio; invalid audio is rejected', async () => {
  const f = await fixture(); f.hass.user.is_admin = false; f.panel.mount(); await flush();
  assert.equal(f.calls.length, 0); assert.match(f.host.textContent, /administrator/);
  assert.throws(() => f.recordingBlob('abc'), /WAV/);
  assert.throws(() => f.recordingBlob('a'.repeat(430001)), /oversized/);
  assert.equal(f.recordingFilename('../../clip<script>'), 'wake-______clip_script_.wav');
});
