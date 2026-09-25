/** Admin review of entity-scoped recordings through authenticated Home Assistant WS. */
import { emitRecordingsUpdated } from './review.js';

const PAGE_SIZE = 25;
const LABELS = [['unreviewed', 'Unreviewed'], ['correct', 'Correct wake'], ['false_trigger', 'False wake'], ['unsure', 'Unsure']];
const PRESENCE = [['uncertain', 'Not sure'], ['present', 'Present'], ['absent', 'Absent']];

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(text, action) {
  const node = element('button', text);
  node.type = 'button'; node.addEventListener('click', action);
  return node;
}

function select(label, choices, selected) {
  const node = element('select');
  node.setAttribute('aria-label', label);
  for (const [value, text] of choices) {
    const option = element('option', text); option.value = value; node.appendChild(option);
  }
  node.value = selected;
  return node;
}

export function recordingBlob(base64) {
  if (typeof base64 !== 'string' || base64.length > 430000) throw new Error('Invalid or oversized recording');
  const decoded = atob(base64);
  if (decoded.length < 44 || decoded.length > 320044 || decoded.slice(0, 4) !== 'RIFF' || decoded.slice(8, 12) !== 'WAVE') {
    throw new Error('Expected a bounded WAV recording');
  }
  const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
  return new Blob([bytes], { type: 'audio/wav' });
}

export function reviewedItems(items) {
  return items.filter(item => ['correct', 'false_trigger', 'unsure'].includes(item.label));
}

export function recordingFilename(id, entityId = '') {
  const owner = entityId ? `${String(entityId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200)}-` : '';
  return `wake-${owner}${String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)}.wav`;
}

export class RecordingsPanel {
  constructor({ host, getHass, getEntityId = () => null, getSession = () => null, standalone = false }) {
    Object.assign(this, { _host: host, _getHass: getHass, _getEntityId: getEntityId, _getSession: getSession });
    this._standalone = standalone; this._selection = null; this._stations = [];
    this._entity = null; this._items = []; this._total = 0; this._offset = 0;
    this._filter = ''; this._config = { mode: 'off', retention_days: 7, max_storage_mb: 250 };
    this._sequence = 0; this._entityEpoch = 0; this._urls = new Set(); this._mounted = false; this._busy = false;
    this._players = new Map();
    this._drafts = new Map(); this._reviewViews = new Map();
    this._onUpdated = event => {
      if (this._emittingReviewUpdate) return;
      if (((!this._standalone || this._entity) && event.detail?.entity_id !== this._entity) || this._busy) return;
      if (this._isPlaying()) this._refreshPending = true;
      else this.refresh();
    };
  }

  mount() {
    if (this._mounted) return;
    this._mounted = true;
    window.addEventListener('voice-satellite-recordings-updated', this._onUpdated);
    this._render(); this.update();
  }

  update() {
    if (!this._mounted) return;
    const entity = (this._standalone ? this._selection : this._getEntityId()) || null;
    const admin = !!this._getHass()?.user?.is_admin;
    if (entity !== this._entity || admin !== this._admin) {
      this._entity = entity; this._admin = admin; this._items = []; this._total = 0; this._offset = 0;
      this._sequence += 1; this._entityEpoch += 1; this._busy = false; this._error = ''; this._refreshPending = false;
      this._config = { mode: 'off', retention_days: 7, max_storage_mb: 250 };
      this._render();
      if ((entity || this._standalone) && admin) this.refresh();
    }
    if (this._refreshPending && !this._busy && !this._isPlaying()) {
      this._refreshPending = false; this.refresh();
    }
    this._updateCaptureStatus();
  }

  _ws(command, data = {}, entityId = this._entity) {
    if (!entityId && command !== 'review_list') return Promise.reject(new Error('Select a satellite first'));
    return this._getHass().callWS({ type: `voice_satellite/recordings/${command}`, ...data, ...(entityId ? { entity_id: entityId } : {}) });
  }

  async refresh() {
    if ((!this._entity && !this._standalone) || !this._admin || !this._mounted) return;
    const sequence = ++this._sequence;
    const entityId = this._entity;
    const revisions = new Map([...this._drafts].map(([key, draft]) => [key, draft.revision]));
    this._error = ''; this._loading = true;
    this._render();
    try {
      const data = await this._ws(this._standalone ? 'review_list' : 'list', { limit: PAGE_SIZE, offset: this._offset, ...(this._filter ? { label: this._filter } : {}) }, entityId);
      if (sequence !== this._sequence || !this._mounted) return;
      this._items = data.items; this._total = data.total;
      for (const item of this._items) {
        const key = this._reviewKey(item);
        const draft = this._drafts.get(key);
        if (draft && !draft.saving && !this._reviewDirty(draft) && draft.revision === revisions.get(key)) {
          draft.label = draft.savedLabel = item.label || 'unreviewed';
          draft.presence = draft.savedPresence = item.word_present || 'uncertain';
        } else if (draft) {
          item.label = draft.savedLabel; item.word_present = draft.savedPresence;
        }
      }
      if (data.config) this._config = data.config;
      if (data.stations) this._stations = data.stations;
      if (this._offset && this._offset >= this._total) {
        this._offset = Math.max(0, Math.ceil(this._total / PAGE_SIZE) - 1) * PAGE_SIZE;
        return this.refresh();
      }
    } catch (error) {
      if (sequence !== this._sequence || !this._mounted) return;
      this._error = error?.message || String(error);
    } finally {
      if (sequence === this._sequence && this._mounted) { this._loading = false; this._render(); }
    }
  }

  async _action(action, { refresh = true } = {}) {
    if (this._busy) return;
    const entityId = this._entity;
    const epoch = this._entityEpoch;
    this._busy = true; this._error = '';
    this._host.querySelectorAll('button, select, input').forEach(node => { node.disabled = true; });
    try {
      await action(entityId);
      if (this._mounted && epoch === this._entityEpoch && refresh) await this.refresh();
    } catch (error) {
      if (this._mounted && epoch === this._entityEpoch) this._error = error?.message || String(error);
    } finally {
      if (epoch === this._entityEpoch) { this._busy = false; if (this._mounted) this._render(); }
    }
  }

  _localManager() {
    const session = this._getSession();
    return session?.config?.satellite_entity === this._entity && session.isStarted ? session.recordings : null;
  }

  _updateCaptureStatus() {
    const manager = this._localManager();
    const status = manager?.getStatus?.();
    if (this._captureButton) this._captureButton.disabled = this._busy || this._config.mode === 'off' || status?.available !== true;
    if (!this._captureStatus) return;
    if (!manager) this._captureStatus.textContent = 'Manual capture is available only on the device running this satellite.';
    else if (this._config.mode === 'off') this._captureStatus.textContent = 'Enable recording before capturing a missed wake.';
    else if (status?.available !== true) this._captureStatus.textContent = 'Recording capture is unavailable on this device or app version.';
    else this._captureStatus.textContent = `Ready on this device. Pending saves: ${status.pending || 0}. Dropped clips: ${status.dropped || 0}.${status.error ? ` ${status.error}` : ''}`;
  }

  async _configure(mode, retentionDays, maxStorageMb) {
    if (!this._entity || this._loading) return;
    await this._action(async entityId => {
      await this._ws('configure', { mode, retention_days: retentionDays, max_storage_mb: maxStorageMb }, entityId);
      if (entityId === this._entity) await this._localManager()?.refreshConfig?.();
      emitRecordingsUpdated(entityId, true);
    });
  }

  async _label(item, label, wordPresent) {
    const draft = this._reviewDraft(item);
    draft.label = label; draft.presence = wordPresent; draft.revision++;
    return this._saveReview(draft);
  }

  _reviewKey(item) { return `${item.entity_id || this._entity}|${item.id}`; }
  _reviewDirty(draft) { return draft.label !== draft.savedLabel || draft.presence !== draft.savedPresence; }

  _reviewDraft(item) {
    const key = this._reviewKey(item);
    if (!this._drafts.has(key)) this._drafts.set(key, {
      key, entityId: item.entity_id || this._entity, id: item.id, revision: 0,
      label: item.label || 'unreviewed', savedLabel: item.label || 'unreviewed',
      presence: item.word_present || 'uncertain', savedPresence: item.word_present || 'uncertain',
      saving: false, error: '', promise: null,
    });
    return this._drafts.get(key);
  }

  _updateReviewStatus(draft) {
    const view = this._reviewViews.get(draft.key);
    if (view) {
      view.status.textContent = draft.error ? `Not saved. ${draft.error}` : draft.saving ? 'Saving…' : this._reviewDirty(draft) ? 'Not saved' : 'Saved';
      view.status.className = draft.error ? 'review-status error' : 'review-status hint';
      view.retry.textContent = draft.error ? 'Retry save' : 'Save review';
      view.retry.disabled = this._busy || draft.saving || !this._reviewDirty(draft);
    }
    if (this._exportButton) this._exportButton.disabled = this._busy || !reviewedItems(this._items).length
      || [...this._drafts.values()].some(row => row.saving || this._reviewDirty(row));
  }

  _saveReview(draft) {
    if (draft.saving) return draft.promise;
    if (!this._mounted || !this._admin || !this._getHass()?.user?.is_admin) return Promise.resolve();
    draft.saving = true; draft.error = '';
    this._updateReviewStatus(draft);
    // Serialize each clip independently. A second answer entered during the
    // first request is sent afterwards, with the latest pair of answers.
    draft.promise = (async () => {
      try {
        while (this._mounted && this._getHass()?.user?.is_admin && this._reviewDirty(draft)) {
          const label = draft.label, presence = draft.presence;
          await this._ws('label', { recording_id: draft.id, label, word_present: presence }, draft.entityId);
          draft.savedLabel = label; draft.savedPresence = presence; draft.revision++;
          for (const item of this._items) if (this._reviewKey(item) === draft.key) {
            item.label = label; item.word_present = presence;
          }
          this._emittingReviewUpdate = true;
          try { emitRecordingsUpdated(draft.entityId); } finally { this._emittingReviewUpdate = false; }
        }
      } catch (error) {
        draft.error = error?.message || String(error);
      } finally {
        draft.saving = false;
        if (this._mounted) this._updateReviewStatus(draft);
      }
    })();
    return draft.promise;
  }

  async _play(item, target, entityId) {
    const scope = this._entity, epoch = this._entityEpoch;
    try {
      const data = await this._ws('get', { recording_id: item.id }, entityId);
      if (!this._mounted || scope !== this._entity || epoch !== this._entityEpoch || !target.isConnected) return;
      this._disposePlayers(target);
      const url = URL.createObjectURL(recordingBlob(data.audio_base64));
      this._urls.add(url);
      const audio = element('audio'); audio.controls = true; audio.src = url;
      audio.setAttribute('aria-label', 'Saved wake recording');
      this._trackPlayer(audio, target, url);
      target.replaceChildren(audio);
      // Playback requires a user's explicit action; never auto-play a captured clip.
    } catch (error) {
      if (this._mounted && scope === this._entity && epoch === this._entityEpoch && target.isConnected) {
        this._disposePlayers(target);
        target.textContent = `Unable to load recording: ${error?.message || String(error)}`;
      }
    }
  }

  _isPlaying() { return [...this._players.keys()].some(audio => audio.paused === false); }

  _trackPlayer(audio, target, url) {
    const player = { target, url, heldSession: null, heldWakeWord: null, disposed: false };
    player.release = () => {
      const wakeWord = player.heldWakeWord;
      const session = player.heldSession;
      player.heldWakeWord = null; player.heldSession = null;
      if (!wakeWord) return;
      // Release this player's own reference only, even after the selected
      // satellite or session changes. TTS may still hold another reference.
      wakeWord.resumeFromPlayback();
      session.recordings?.review?.tick();
    };
    player.start = () => {
      if (player.disposed || player.heldWakeWord) return;
      // The local microphone hears playback even when reviewing a remote
      // satellite. Resolve the local session when Play is pressed, not on load.
      const session = this._getSession();
      const wakeWord = session?.wakeWord;
      if (typeof wakeWord?.suspendForPlayback !== 'function' || typeof wakeWord?.resumeFromPlayback !== 'function') return;
      player.heldSession = session; player.heldWakeWord = wakeWord;
      wakeWord.suspendForPlayback();
      session.recordings?.review?.tick();
    };
    audio.addEventListener('play', player.start);
    for (const event of ['pause', 'ended', 'error']) audio.addEventListener(event, player.release);
    this._players.set(audio, player);
  }

  _disposePlayers(target) {
    for (const [audio, player] of this._players) {
      if (target && player.target !== target) continue;
      player.disposed = true;
      // Removing/replacing an audio element does not reliably stop playback.
      // Pause while it is still attached, then balance our hold explicitly in
      // case the browser delivers its pause event asynchronously.
      try { audio.pause(); } finally {
        try { player.release(); } finally {
          audio.removeEventListener('play', player.start);
          for (const event of ['pause', 'ended', 'error']) audio.removeEventListener(event, player.release);
          URL.revokeObjectURL(player.url); this._urls.delete(player.url);
          this._players.delete(audio);
        }
      }
    }
  }

  _download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = element('a'); link.href = url; link.download = filename;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async _downloadWav(item, entityId) {
    const scope = this._entity, epoch = this._entityEpoch;
    await this._action(async () => {
      const data = await this._ws('get', { recording_id: item.id }, entityId);
      if (this._mounted && scope === this._entity && epoch === this._entityEpoch) this._download(recordingBlob(data.audio_base64), recordingFilename(item.id, item.entity_id));
    }, { refresh: false });
  }

  async _exportReviewedPage() {
    const epoch = this._entityEpoch;
    await this._action(async entityId => {
      const pending = [...this._drafts.values()].filter(row => row.saving).map(row => row.promise);
      if (pending.length) await Promise.all(pending);
      if (!this._mounted || entityId !== this._entity || epoch !== this._entityEpoch) return;
      if ([...this._drafts.values()].some(row => this._reviewDirty(row))) throw new Error('Some reviews are not saved. Retry their saves before exporting.');
      const items = reviewedItems(this._items).slice(0, PAGE_SIZE);
      const exported = [];
      for (const item of items) {
        if (!this._mounted || entityId !== this._entity || epoch !== this._entityEpoch) return;
        const owner = item.entity_id || entityId;
        const data = await this._ws('get', { recording_id: item.id }, owner);
        // Recheck the stored label: another admin may have changed it since listing.
        if (!reviewedItems([data.item]).length) continue;
        recordingBlob(data.audio_base64);
        exported.push({ ...data.item, entity_id: owner, station_name: item.station_name,
          wav_filename: recordingFilename(data.item.id, item.entity_id), audio_base64: data.audio_base64 });
      }
      if (!this._mounted || entityId !== this._entity || epoch !== this._entityEpoch) return;
      const manifest = { format: 'voice_satellite_reviewed_recordings_v1', entity_id: entityId,
        exported_at: new Date().toISOString(), scope: 'reviewed_items_on_displayed_page',
        label_policy: 'Feedback and acoustic word presence are independent user labels. No automatic training label is inferred.', items: exported };
      this._download(new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }), 'reviewed-wake-recordings.json');
    }, { refresh: false });
  }

  _render() {
    if (!this._mounted) return;
    this._disposePlayers();
    this._urls.forEach(url => URL.revokeObjectURL(url)); this._urls.clear();
    this._reviewViews.clear(); this._exportButton = null;
    const root = element('div', undefined, 'vsp-recordings');
    this._captureButton = null; this._captureStatus = null;
    const style = element('style');
    style.textContent = '.vsp-recordings .row{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:12px 0}.vsp-recordings button,.vsp-recordings select,.vsp-recordings input{min-height:38px;font:inherit;border:1px solid var(--divider-color,#ccc);border-radius:6px;padding:6px 10px;color:var(--primary-text-color);background:var(--card-background-color)}.vsp-recordings button{cursor:pointer}.vsp-recordings button:disabled{opacity:.5;cursor:default}.vsp-recordings article{border-top:1px solid var(--divider-color,#ddd);padding:12px 0}.vsp-recordings .hint{font-size:13px;color:var(--secondary-text-color);line-height:1.5}.vsp-recordings .error{color:var(--error-color,#b00)}.vsp-recordings audio{width:100%;margin-top:8px}.vsp-recordings input{width:80px}.vsp-recordings h3{margin:0 0 10px;font-size:18px}';
    root.append(style, element('h3', this._standalone ? 'Recordings inbox' : 'Wake recordings'));
    style.textContent += '.vsp-recordings .review-fields{display:flex;flex-wrap:wrap;align-items:end;gap:12px;margin:12px 0}.vsp-recordings .review-fields label{display:flex;flex-direction:column;gap:6px;min-width:0}.vsp-recordings .review-fields select{max-width:100%;min-height:44px}.vsp-recordings .review-save{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:8px 0}.vsp-recordings .review-save button{min-height:44px;font-weight:600}.vsp-recordings .review-status{overflow-wrap:anywhere}.vsp-recordings .short-clip{margin-top:6px;font-weight:600}';
    root.appendChild(element('p', this._standalone
      ? 'Listen, label, and export saved clips from your stations. Choosing a station here only filters the inbox.'
      : 'Save up to five seconds ending at a wake detection for later review. Audio stays in Home Assistant unless you export it. Recording is off by default.', 'hint'));
    if (!this._admin) root.appendChild(element('p', 'A Home Assistant administrator is required to change recording settings or review saved audio.'));
    else if (!this._entity && !this._standalone) root.appendChild(element('p', 'Select a satellite to manage its recordings.'));
    else {
      if (this._standalone) {
        const stations = element('div', undefined, 'row');
        const choices = [['', 'All stations'], ...this._stations.map(station => [station.entity_id, station.name])];
        if (this._entity && !this._stations.some(station => station.entity_id === this._entity)) choices.push([this._entity, this._entity]);
        const selector = select('Review recordings from station', choices, this._entity || '');
        selector.addEventListener('change', () => { this._selection = selector.value || null; this.update(); });
        stations.append(element('span', 'Station'), selector); root.appendChild(stations);
      }
      if (this._entity) {
      const settings = element('div', undefined, 'row');
      const mode = select('Recording mode', [['off', 'Off'], ['save', 'Save'], ['review', 'Save + feedback']], this._config.mode);
      const retention = element('input'); retention.type = 'number'; retention.min = '1'; retention.max = '365'; retention.value = this._config.retention_days;
      retention.setAttribute('aria-label', 'Retention days');
      const quota = element('input'); quota.type = 'number'; quota.min = '1'; quota.max = '2048'; quota.value = this._config.max_storage_mb;
      quota.setAttribute('aria-label', 'Storage limit in MB');
      const apply = button('Apply settings', () => {
        const days = Number(retention.value), mb = Number(quota.value);
        if (!Number.isInteger(days) || !Number.isInteger(mb) || !retention.checkValidity() || !quota.checkValidity()) {
          this._error = 'Enter valid whole-number retention and storage limits.'; this._render(); return;
        }
        this._configure(mode.value, days, mb);
      });
      apply.disabled = this._loading || !!this._error;
      settings.append(mode, element('span', 'Keep days'), retention, element('span', 'Limit MB'), quota, apply);
      root.append(settings, element('p', 'Save + feedback asks silently after the voice interaction finishes. Feedback and whether the wake word was actually spoken are recorded separately. Retention applies to reviewed and unreviewed clips; a full storage limit stops new saves.', 'hint'));
      const captureRow = element('div', undefined, 'row');
      this._captureButton = button('Capture missed wake', () => this._action(async () => {
        const manager = this._localManager();
        if (!manager || manager.getStatus()?.available !== true || this._config.mode === 'off') throw new Error('Capture is unavailable on this device');
        await manager.captureMissed();
      }));
      this._captureStatus = element('span', '', 'hint');
      captureRow.append(this._captureButton, this._captureStatus); root.appendChild(captureRow);
      } else root.appendChild(element('p', 'Choose one station to change its recording settings. Audio stays in Home Assistant unless you export it.', 'hint'));
      const tools = element('div', undefined, 'row');
      const filter = select('Filter recording review state', [['', 'All recordings'], ...LABELS], this._filter);
      filter.addEventListener('change', () => { this._filter = filter.value; this._offset = 0; this.refresh(); });
      const exportButton = button('Export reviewed page', () => this._exportReviewedPage());
      this._exportButton = exportButton;
      exportButton.disabled = !reviewedItems(this._items).length;
      tools.append(filter, button('Refresh', () => this.refresh()), exportButton); root.appendChild(tools);
      root.appendChild(element('p', 'Changes save automatically. Check for Saved below each recording. Export includes only saved reviews on this page.', 'hint'));
      if (this._loading) root.appendChild(element('p', 'Loading recordings…'));
      else if (!this._items.length) root.appendChild(element('p', 'No recordings in this view.'));
      for (const item of this._items) {
        const entityId = item.entity_id || this._entity;
        const row = element('article');
        const date = new Date(item.created_at);
        row.appendChild(element('strong', Number.isNaN(date.getTime()) ? String(item.created_at || 'Recording') : date.toLocaleString()));
        if (this._standalone) row.appendChild(element('div', item.station_name || entityId, 'hint'));
        const metadata = item.metadata || {};
        row.appendChild(element('div', [metadata.capture_kind === 'missed' ? 'Missed wake capture' : 'Wake detection', metadata.engine, metadata.model].filter(Boolean).join(' · '), 'hint'));
        const duration = Number(item.duration_seconds ?? metadata.pre_seconds);
        if (Number.isFinite(duration) && duration >= 0) {
          row.appendChild(element('div', `${duration.toFixed(2)} s${duration < 1 ? ' · Short clip — limited audio context' : metadata.discontinuity ? ' · Partial audio history' : ''}`, duration < 1 ? 'hint short-clip' : 'hint'));
        }
        const draft = this._reviewDraft(item);
        const fields = element('div', undefined, 'review-fields');
        const label = select('Wake feedback', LABELS, draft.label);
        const presence = select('Wake word present in recording', PRESENCE, draft.presence);
        const feedbackField = element('label', 'Was this an intended wake?'); feedbackField.appendChild(label);
        const presenceField = element('label', 'Was the wake word spoken?'); presenceField.appendChild(presence);
        fields.append(feedbackField, presenceField);
        const change = () => this._label(item, label.value, presence.value);
        label.addEventListener('change', change); presence.addEventListener('change', change);
        const saveRow = element('div', undefined, 'review-save');
        const retry = button('Save review', change);
        const status = element('span', '', 'review-status hint'); status.setAttribute('role', 'status');
        saveRow.append(retry, status);
        this._reviewViews.set(draft.key, { status, retry });
        this._updateReviewStatus(draft);
        const controls = element('div', undefined, 'row');
        const player = element('div');
        controls.append(button('Listen', () => this._play(item, player, entityId)), button('Download WAV', () => this._downloadWav(item, entityId)),
          button('Delete', () => {
            if (window.confirm('Delete this saved recording and its review?')) this._action(async () => {
              await this._ws('delete', { recording_id: item.id }, entityId); emitRecordingsUpdated(entityId);
            });
          }));
        row.append(fields, saveRow, controls, player); root.appendChild(row);
      }
      const pages = element('div', undefined, 'row');
      const prev = button('Previous', () => { this._offset = Math.max(0, this._offset - PAGE_SIZE); this.refresh(); });
      const next = button('Next', () => { this._offset += PAGE_SIZE; this.refresh(); });
      prev.disabled = this._offset === 0; next.disabled = this._offset + PAGE_SIZE >= this._total;
      pages.append(prev, element('span', `${this._items.length ? this._offset + 1 : 0}–${this._offset + this._items.length} of ${this._total}`), next); root.appendChild(pages);
      if (this._busy) root.querySelectorAll('button, select, input').forEach(node => { node.disabled = true; });
    }
    if (this._error) { const error = element('p', this._error, 'error'); error.setAttribute('role', 'alert'); root.appendChild(error); }
    this._host.replaceChildren(root);
    this._updateCaptureStatus();
  }

  destroy() {
    this._mounted = false; this._sequence += 1; this._entityEpoch += 1;
    window.removeEventListener('voice-satellite-recordings-updated', this._onUpdated);
    this._disposePlayers();
    this._urls.forEach(url => URL.revokeObjectURL(url)); this._urls.clear();
    this._host.replaceChildren();
  }
}
