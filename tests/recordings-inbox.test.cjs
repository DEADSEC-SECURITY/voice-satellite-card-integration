const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

class Element {
  constructor(tag = 'host') { this.tagName = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.style = {}; this.value = ''; this.paused = true; this._text = ''; }
  get isConnected() { return this.tagName === 'body' || !!this.parentNode?.isConnected; }
  set textContent(text) { this._text = String(text); this.children = []; }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  appendChild(node) { node.parentNode = this; this.children.push(node); return node; }
  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
  replaceChildren(...nodes) { this.children.forEach(node => { node.parentNode = null; }); this.children = []; this._text = ''; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  removeEventListener(name, callback) { if (this.listeners[name] === callback) delete this.listeners[name]; }
  querySelectorAll(selector) { return this.children.flatMap(node => [...(selector.split(',').map(s => s.trim()).includes(node.tagName) ? [node] : []), ...node.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  click() { if (!this.disabled) return this.listeners.click?.(); }
  pause() { this.paused = true; this.listeners.pause?.(); }
  checkValidity() { return true; }
}
const station = (entity_id, name) => ({ entity_id, name });
const kitchen = station('assist_satellite.kitchen', 'Kitchen tablet');
const bedroom = station('assist_satellite.bedroom', 'Bedroom');
const policy = { mode: 'review', retention_days: 7, max_storage_mb: 250 };
const item = (id, entity = kitchen, label = 'unreviewed') => ({ id, entity_id: entity.entity_id, station_name: entity.name, label, word_present: 'uncertain', created_at: '2026-09-25T12:00:00Z' });
const listing = (items = [], config = null) => ({ items, total: items.length, config, stations: [bedroom, kitchen] });
const wav = () => { const bytes = Buffer.alloc(44); bytes.write('RIFF'); bytes.write('WAVE', 8); return bytes.toString('base64'); };
function find(node, tag, text) { return node.querySelectorAll(tag).find(child => child.textContent === text); }

async function fixture() {
  const calls = [], downloads = [], created = [], navigations = [], events = new Map(), definitions = new Map();
  const body = new Element('body');
  const response = { value: async request => request.type.endsWith('/review_list') ? listing() : {} };
  const hass = { user: { is_admin: true }, callWS: async request => { calls.push(request); return response.value(request); } };
  const session = { config: { satellite_entity: 'assist_satellite.laptop' }, isStarted: false,
    start: () => { throw new Error('Review must not start'); }, teardown: () => { throw new Error('Review must not stop'); }, updateConfig: () => { throw new Error('Review must not reconfigure'); } };
  const window = { __vsSession: session, confirm: () => true,
    history: { pushState(_state, _unused, url) { navigations.push(url); } },
    addEventListener(name, callback) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(callback); },
    removeEventListener(name, callback) { events.get(name)?.delete(callback); },
    dispatchEvent(event) { events.get(event.type)?.forEach(callback => callback(event)); } };
  const context = vm.createContext({ console, window, HTMLElement: Element, Blob, Uint8Array,
    document: { body, createElement: tag => new Element(tag) },
    localStorage: new Proxy({}, { get() { throw new Error('Review must not access device assignment'); } }),
    navigator: { mediaDevices: new Proxy({}, { get() { throw new Error('Review must not access microphone'); } }) },
    customElements: { get: name => definitions.get(name), define: (name, value) => definitions.set(name, value) },
    CustomEvent: class { constructor(type, data) { this.type = type; this.detail = data.detail; } },
    URL: { createObjectURL(blob) { created.push(blob); return 'blob:fixture'; }, revokeObjectURL() {} },
    atob: value => Buffer.from(value, 'base64').toString('binary'), setTimeout: () => 1, clearTimeout() {} });
  const modules = new Map();
  const load = filename => { if (!modules.has(filename)) modules.set(filename, new vm.SourceTextModule(readFileSync(filename, 'utf8'), { context, identifier: filename })); return modules.get(filename); };
  const module = load(path.join(root, 'src/recordings/page.js'));
  await module.link((specifier, parent) => load(path.resolve(path.dirname(parent.identifier), specifier)));
  await module.evaluate();
  const page = new module.namespace.VoiceSatelliteRecordingsPage(); body.append(page); page.hass = hass;
  const panel = page._review; panel._download = (blob, filename) => downloads.push({ blob, filename });
  const selectStation = async entity => { const selector = page.querySelectorAll('select').find(node => node.attributes['aria-label'] === 'Review recordings from station'); selector.value = entity || ''; selector.listeners.change(); await flush(); };
  return { page, panel, body, hass, session, calls, response, downloads, created, window, selectStation, navigations, navigateReviewLink: module.namespace.navigateReviewLink };
}

test('direct review page starts in all stations without any assignment, config, or microphone activity', async () => {
  const f = await fixture(); await flush();
  assert.deepEqual(f.calls.map(call => call.type), ['voice_satellite/recordings/review_list']);
  assert.equal('entity_id' in f.calls[0], false);
  assert.equal(f.session.config.satellite_entity, 'assist_satellite.laptop');
  assert.equal(find(f.page, 'button', 'Apply settings'), undefined);
  assert.equal(find(f.page, 'button', 'Capture missed wake'), undefined);
  f.response.value = async () => listing([], policy);
  await f.selectStation(kitchen.entity_id);
  assert.equal(f.calls.at(-1).entity_id, kitchen.entity_id);
  assert.equal(f.calls.every(call => call.type.endsWith('/review_list')), true);
  assert.equal(f.session.config.satellite_entity, 'assist_satellite.laptop');
  f.page.disconnectedCallback();
});

test('navigation between device and review uses HA routing without unloading an existing satellite', async () => {
  const f = await fixture(); await flush(); let prevented = 0, changed = 0;
  f.window.addEventListener('location-changed', () => { changed++; });
  f.session.isStarted = true;
  const event = { button: 0, preventDefault() { prevented++; } };
  f.navigateReviewLink(event, '/voice-satellite-recordings');
  assert.deepEqual(f.navigations, ['/voice-satellite-recordings']);
  assert.equal(changed, 1); assert.equal(prevented, 1); assert.equal(f.session.isStarted, true);
  f.navigateReviewLink({ ...event, ctrlKey: true }, '/voice-satellite-recordings');
  assert.equal(f.navigations.length, 1, 'New-tab keyboard shortcut keeps normal link behavior');
});

test('all-station review routes labels, playback, WAV, deletion and export to each clip owner', async () => {
  const f = await fixture(); await flush();
  const first = item('first', kitchen, 'correct'), second = item('second', bedroom, 'false_trigger');
  f.response.value = async request => {
    if (request.type.endsWith('/review_list')) return listing([first, second]);
    if (request.type.endsWith('/get')) return { item: { id: request.recording_id, label: 'correct' }, audio_base64: wav() };
    return {};
  };
  await f.panel.refresh(); f.calls.length = 0;
  assert.match(f.page.textContent, /Kitchen tablet/); assert.match(f.page.textContent, /Bedroom/);
  await f.panel._label(second, 'false_trigger', 'absent');
  assert.equal(f.calls.find(call => call.type.endsWith('/label')).entity_id, bedroom.entity_id);
  const target = new Element('div'); f.page.append(target);
  await f.panel._play(first, target, first.entity_id);
  assert.equal(f.calls.at(-1).entity_id, kitchen.entity_id);
  assert.equal(target.querySelector('audio').autoplay, undefined);
  await f.panel._downloadWav(second, second.entity_id);
  assert.equal(f.calls.at(-1).entity_id, bedroom.entity_id);
  f.downloads.length = 0; await f.panel._exportReviewedPage();
  const exported = JSON.parse(await f.downloads[0].blob.text());
  assert.deepEqual(exported.items.map(row => row.entity_id), [kitchen.entity_id, bedroom.entity_id]);
  assert.equal(exported.entity_id, null);
  find(f.page.querySelectorAll('article')[1], 'button', 'Delete').click(); await flush();
  assert.equal(f.calls.find(call => call.type.endsWith('/delete')).entity_id, bedroom.entity_id);
});

test('all-station pagination and filters go to the server without selecting a runtime', async () => {
  const f = await fixture(); await flush();
  f.response.value = async () => ({ ...listing(Array.from({ length: 25 }, (_, i) => item(String(i)))), total: 60 });
  await f.panel.refresh();
  find(f.page, 'button', 'Next').click(); await flush();
  assert.equal(f.calls.at(-1).offset, 25); assert.equal(f.calls.at(-1).entity_id, undefined);
  const filter = f.page.querySelectorAll('select').find(node => node.attributes['aria-label'] === 'Filter recording review state');
  filter.value = 'unreviewed'; filter.listeners.change(); await flush();
  assert.equal(f.calls.at(-1).offset, 0); assert.equal(f.calls.at(-1).label, 'unreviewed');
});

test('late all-station list and playback cannot leak into a new station view', async () => {
  const f = await fixture(); await flush(); const pending = [];
  f.response.value = request => new Promise(resolve => pending.push({ request, resolve }));
  const oldList = f.panel.refresh();
  f.panel._selection = kitchen.entity_id; f.panel.update();
  pending[1].resolve(listing([item('kitchen')], policy)); await flush();
  pending[0].resolve(listing([item('old-bedroom', bedroom)])); await oldList;
  assert.equal(f.panel._items[0].id, 'kitchen');
  const target = new Element('div'); f.page.append(target);
  const oldAudio = f.panel._play(item('kitchen'), target, kitchen.entity_id);
  f.panel._selection = null; f.panel.update();
  pending[2].resolve({ audio_base64: wav() }); await oldAudio;
  assert.equal(f.created.length, 0);
  pending[3].resolve(listing()); await flush();
});

test('review export is discarded when view changes away and back while awaiting audio', async () => {
  const f = await fixture(); await flush();
  f.panel._items = [item('old', kitchen, 'correct')];
  let resolveAudio;
  f.response.value = request => request.type.endsWith('/get') ? new Promise(resolve => { resolveAudio = resolve; }) : Promise.resolve(listing());
  const request = f.panel._exportReviewedPage();
  f.panel._selection = bedroom.entity_id; f.panel.update();
  f.panel._selection = null; f.panel.update(); await flush();
  resolveAudio({ item: { id: 'old', label: 'correct' }, audio_base64: wav() }); await request;
  assert.equal(f.downloads.length, 0);
});

test('review requires admin and only explicit individual settings Apply can configure recording', async () => {
  const f = await fixture(); await flush();
  await f.panel._configure('off', 7, 250);
  assert.equal(f.calls.some(call => call.type.endsWith('/configure')), false);
  f.response.value = async () => listing([], policy);
  await f.selectStation(kitchen.entity_id);
  await f.panel._configure('review', 14, 100);
  const configured = f.calls.find(call => call.type.endsWith('/configure'));
  assert.equal(configured.entity_id, kitchen.entity_id); assert.equal(configured.mode, 'review');
  f.calls.length = 0; f.hass.user.is_admin = false; f.page.hass = f.hass;
  assert.match(f.page.textContent, /administrator is required/); assert.equal(f.calls.length, 0);
});

test('opening device settings preserves locally disabled auto-start while hydrating shared settings', async () => {
  // Execute the actual asynchronous panel method without booting HA's settings components.
  const source = readFileSync(path.join(root, 'src/panel/index.js'), 'utf8');
  const method = source.slice(source.indexOf('  async _loadServerConfigForSelectedEntity('), source.indexOf('\n  _syncConfigToUi('));
  const load = vm.runInNewContext(`(${method.trim().replace('async _loadServerConfigForSelectedEntity', 'async function')})`, {
    DEFAULT_CONFIG: { auto_start: true, skin: 'default' },
    loadPanelConfig: async () => ({ exists: true, config: { skin: 'chat' } }),
  });
  const panel = { _config: { satellite_entity: kitchen.entity_id, auto_start: false, skin: 'old' }, _hass: {},
    _serverConfigLoadSeq: 0, _localChangeVersion: 0, _getSession: () => null,
    _persistLocalConfig() { this.saved = { ...this._config }; }, _syncConfigToUi() {} };
  await load.call(panel);
  assert.equal(panel._config.skin, 'chat');
  assert.equal(panel._config.auto_start, false);
  assert.equal(panel.saved.auto_start, false);
  assert.equal(panel._config.satellite_entity, kitchen.entity_id);
});

test('review choices autosave in order without replacing the controls or losing the second answer', async () => {
  const f = await fixture(); await flush();
  const clip = item('autosave');
  let complete;
  f.response.value = request => request.type.endsWith('/review_list') ? Promise.resolve(listing([clip]))
    : new Promise(resolve => { complete = resolve; });
  await f.panel.refresh();
  const row = f.page.querySelectorAll('article')[0];
  const [label, presence] = row.querySelectorAll('select');
  label.value = 'false_trigger'; label.listeners.change();
  assert.match(row.textContent, /Saving/);
  presence.value = 'absent'; presence.listeners.change();
  assert.equal(f.calls.filter(r => r.type.endsWith('/label')).length, 1);
  complete({}); await flush();
  const last = f.calls.at(-1);
  assert.equal(last.label, 'false_trigger'); assert.equal(last.word_present, 'absent');
  complete({}); await flush();
  assert.equal(f.page.querySelectorAll('article')[0], row, 'Saving does not destroy playback or the edited row');
  assert.match(row.textContent, /Saved/);
  assert.equal(f.panel._items[0].word_present, 'absent');
  assert.equal(find(row, 'button', 'Save review').disabled, true);
});

test('failed autosave keeps both answers through refresh, blocks stale export, and supports retry', async () => {
  const f = await fixture(); await flush(); const clip = item('retry');
  f.response.value = async request => {
    if (request.type.endsWith('/review_list')) return listing([structuredClone(clip)]);
    throw new Error('Connection lost');
  };
  await f.panel.refresh();
  await f.panel._label(clip, 'false_trigger', 'absent');
  await f.panel.refresh();
  const row = f.page.querySelectorAll('article')[0];
  assert.equal(row.querySelectorAll('select')[0].value, 'false_trigger');
  assert.equal(row.querySelectorAll('select')[1].value, 'absent');
  assert.match(row.textContent, /Not saved.*Connection lost/);
  await f.panel._exportReviewedPage();
  assert.equal(f.downloads.length, 0);
  f.response.value = async request => request.type.endsWith('/label') ? {} : listing([clip]);
  await find(f.page, 'button', 'Retry save').click(); await flush();
  assert.match(f.page.querySelectorAll('article')[0].textContent, /Saved/);
  assert.equal(f.calls.filter(r => r.type.endsWith('/label')).at(-1).word_present, 'absent');
});

test('a list begun before an edit cannot roll back its saved answers', async () => {
  const f = await fixture(); await flush(); const clip = item('race');
  f.response.value = async () => listing([structuredClone(clip)]); await f.panel.refresh();
  let completeList;
  f.response.value = request => request.type.endsWith('/review_list')
    ? new Promise(resolve => { completeList = resolve; }) : Promise.resolve({});
  const refresh = f.panel.refresh();
  await f.panel._label(clip, 'false_trigger', 'absent');
  completeList(listing([structuredClone(clip)])); await refresh;
  assert.equal(f.panel._items[0].label, 'false_trigger');
  assert.equal(f.page.querySelectorAll('article')[0].querySelectorAll('select')[1].value, 'absent');
});

test('subsecond recordings display their real duration and limited context', async () => {
  const f = await fixture(); await flush();
  f.response.value = async () => listing([{ ...item('short'), metadata: { pre_seconds: .24, discontinuity: true } }]);
  await f.panel.refresh();
  assert.match(f.page.textContent, /0\.24 s.*Short clip/);
});
