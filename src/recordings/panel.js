/** Admin review of entity-scoped recordings through authenticated Home Assistant WS. */
import { emitRecordingsUpdated } from './review.js';
import { element, button, select } from './dom.js';
import { RECORDINGS_PANEL_STYLES } from './styles.js';
const PAGE_SIZE = 25;
const LABELS = [
  ['unreviewed', 'Unreviewed'],
  ['correct', 'Correct wake'],
  ['false_trigger', 'False wake'],
  ['unsure', 'Unsure'],
];
const PRESENCE = [
  ['uncertain', 'Not sure'],
  ['present', 'Present'],
  ['absent', 'Absent'],
];

export function recordingBlob(base64) {
  if (typeof base64 !== 'string' || base64.length > 430000) {
    throw new Error('Invalid or oversized recording');
  }
  const decoded = atob(base64);
  if (
    decoded.length < 44 ||
    decoded.length > 320044 ||
    decoded.slice(0, 4) !== 'RIFF' ||
    decoded.slice(8, 12) !== 'WAVE'
  ) {
    throw new Error('Expected a bounded WAV recording');
  }
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  return new Blob([bytes], { type: 'audio/wav' });
}

export function reviewedItems(items) {
  return items.filter((item) => ['correct', 'false_trigger', 'unsure'].includes(item.label));
}

export function recordingFilename(id, entityId = '') {
  const owner = entityId
    ? `${String(entityId)
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .slice(0, 200)}-`
    : '';
  return `wake-${owner}${String(id)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 80)}.wav`;
}

export class RecordingsPanel {
  constructor({
    host,
    getHass,
    getEntityId = () => null,
    getSession = () => null,
    standalone = false,
  }) {
    Object.assign(this, {
      _host: host,
      _getHass: getHass,
      _getEntityId: getEntityId,
      _getSession: getSession,
    });
    this._standalone = standalone;
    this._selection = null;
    this._stations = [];
    this._entity = null;
    this._items = [];
    this._total = 0;
    this._offset = 0;
    this._filter = '';
    this._config = { mode: 'off', retention_days: 7, max_storage_mb: 250 };
    // Ignore stale list replies and actions after the selected view changes.
    this._listRequestId = 0;
    this._viewRevision = 0;
    this._urls = new Set();
    this._mounted = false;
    this._busy = false;
    this._players = new Map();
    // Drafts survive refresh and pagination until their saved answers catch up.
    this._drafts = new Map();
    this._reviewViews = new Map();
    this._onUpdated = (event) => {
      if (this._emittingReviewUpdate) {
        return;
      }
      if (
        ((!this._standalone || this._entity) && event.detail?.entity_id !== this._entity) ||
        this._busy
      ) {
        return;
      }
      if (this._isPlaying()) {
        this._refreshPending = true;
      } else {
        this.refresh();
      }
    };
  }

  mount() {
    if (this._mounted) {
      return;
    }
    this._mounted = true;
    window.addEventListener('voice-satellite-recordings-updated', this._onUpdated);
    this._render();
    this.update();
  }

  update() {
    if (!this._mounted) {
      return;
    }
    const entity = (this._standalone ? this._selection : this._getEntityId()) || null;
    const admin = !!this._getHass()?.user?.is_admin;
    if (entity !== this._entity || admin !== this._admin) {
      this._entity = entity;
      this._admin = admin;
      this._items = [];
      this._total = 0;
      this._offset = 0;
      this._listRequestId += 1;
      this._viewRevision += 1;
      this._busy = false;
      this._error = '';
      this._refreshPending = false;
      this._config = { mode: 'off', retention_days: 7, max_storage_mb: 250 };
      this._render();
      if ((entity || this._standalone) && admin) {
        this.refresh();
      }
    }
    if (this._refreshPending && !this._busy && !this._isPlaying()) {
      this._refreshPending = false;
      this.refresh();
    }
    this._updateCaptureStatus();
  }

  _request(command, data = {}, entityId = this._entity) {
    if (!entityId && command !== 'review_list') {
      return Promise.reject(new Error('Select a satellite first'));
    }
    return this._getHass().callWS({
      type: `voice_satellite/recordings/${command}`,
      ...data,
      ...(entityId ? { entity_id: entityId } : {}),
    });
  }

  async refresh() {
    if ((!this._entity && !this._standalone) || !this._admin || !this._mounted) {
      return;
    }
    const sequence = ++this._listRequestId;
    const entityId = this._entity;
    const revisions = new Map([...this._drafts].map(([key, draft]) => [key, draft.revision]));
    this._error = '';
    this._loading = true;
    this._render();
    try {
      const data = await this._request(
        this._standalone ? 'review_list' : 'list',
        {
          limit: PAGE_SIZE,
          offset: this._offset,
          ...(this._filter ? { label: this._filter } : {}),
        },
        entityId
      );
      if (sequence !== this._listRequestId || !this._mounted) {
        return;
      }
      this._items = data.items;
      this._total = data.total;
      for (const item of this._items) {
        const key = this._reviewKey(item);
        const draft = this._drafts.get(key);
        if (
          draft &&
          !draft.saving &&
          !this._hasUnsavedReview(draft) &&
          draft.revision === revisions.get(key)
        ) {
          draft.label = draft.savedLabel = item.label || 'unreviewed';
          draft.presence = draft.savedPresence = item.word_present || 'uncertain';
        } else if (draft) {
          item.label = draft.savedLabel;
          item.word_present = draft.savedPresence;
        }
      }
      if (data.config) {
        this._config = data.config;
      }
      if (data.stations) {
        this._stations = data.stations;
      }
      if (this._offset && this._offset >= this._total) {
        this._offset = Math.max(0, Math.ceil(this._total / PAGE_SIZE) - 1) * PAGE_SIZE;
        return this.refresh();
      }
    } catch (error) {
      if (sequence !== this._listRequestId || !this._mounted) {
        return;
      }
      this._error = error?.message || String(error);
    } finally {
      if (sequence === this._listRequestId && this._mounted) {
        this._loading = false;
        this._render();
      }
    }
  }

  async _runAction(action, { refresh = true } = {}) {
    if (this._busy) {
      return;
    }
    const entityId = this._entity;
    const epoch = this._viewRevision;
    this._busy = true;
    this._error = '';
    this._host.querySelectorAll('button, select, input').forEach((node) => {
      node.disabled = true;
    });
    try {
      await action(entityId);
      if (this._mounted && epoch === this._viewRevision && refresh) {
        await this.refresh();
      }
    } catch (error) {
      if (this._mounted && epoch === this._viewRevision) {
        this._error = error?.message || String(error);
      }
    } finally {
      if (epoch === this._viewRevision) {
        this._busy = false;
        if (this._mounted) {
          this._render();
        }
      }
    }
  }

  _localManager() {
    const session = this._getSession();
    return session?.config?.satellite_entity === this._entity && session.isStarted
      ? session.recordings
      : null;
  }

  _updateCaptureStatus() {
    const manager = this._localManager();
    const status = manager?.getStatus?.();
    if (this._captureButton) {
      this._captureButton.disabled =
        this._busy || this._config.mode === 'off' || status?.available !== true;
    }
    if (!this._captureStatus) {
      return;
    }
    if (!manager) {
      this._captureStatus.textContent =
        'Manual capture is available only on the device running this satellite.';
    } else if (this._config.mode === 'off') {
      this._captureStatus.textContent = 'Enable recording before capturing a missed wake.';
    } else if (status?.available !== true) {
      this._captureStatus.textContent =
        'Recording capture is unavailable on this device or app version.';
    } else {
      this._captureStatus.textContent = `Ready on this device. Pending saves: ${status.pending || 0}. Dropped clips: ${status.dropped || 0}.${status.error ? ` ${status.error}` : ''}`;
    }
  }

  async _configure(mode, retentionDays, maxStorageMb) {
    if (!this._entity || this._loading) {
      return;
    }
    await this._runAction(async (entityId) => {
      await this._request(
        'configure',
        { mode, retention_days: retentionDays, max_storage_mb: maxStorageMb },
        entityId
      );
      if (entityId === this._entity) {
        await this._localManager()?.refreshConfig?.();
      }
      emitRecordingsUpdated(entityId, true);
    });
  }

  async _label(item, label, wordPresent) {
    const draft = this._reviewDraft(item);
    draft.label = label;
    draft.presence = wordPresent;
    draft.revision++;
    return this._saveReview(draft);
  }

  _reviewKey(item) {
    return `${item.entity_id || this._entity}|${item.id}`;
  }

  _hasUnsavedReview(draft) {
    return draft.label !== draft.savedLabel || draft.presence !== draft.savedPresence;
  }

  _reviewDraft(item) {
    const key = this._reviewKey(item);
    if (!this._drafts.has(key)) {
      this._drafts.set(key, {
        key,
        entityId: item.entity_id || this._entity,
        id: item.id,
        revision: 0,
        label: item.label || 'unreviewed',
        savedLabel: item.label || 'unreviewed',
        presence: item.word_present || 'uncertain',
        savedPresence: item.word_present || 'uncertain',
        saving: false,
        error: '',
        promise: null,
      });
    }
    return this._drafts.get(key);
  }

  _updateReviewStatus(draft) {
    const view = this._reviewViews.get(draft.key);
    if (view) {
      if (draft.error) {
        view.status.textContent = `Not saved. ${draft.error}`;
      } else if (draft.saving) {
        view.status.textContent = 'Saving…';
      } else if (this._hasUnsavedReview(draft)) {
        view.status.textContent = 'Not saved';
      } else {
        view.status.textContent = 'Saved';
      }
      view.status.className = draft.error ? 'review-status error' : 'review-status hint';
      view.retry.textContent = draft.error ? 'Retry save' : 'Save review';
      view.retry.disabled = this._busy || draft.saving || !this._hasUnsavedReview(draft);
    }
    if (this._exportButton) {
      this._exportButton.disabled =
        this._busy ||
        !reviewedItems(this._items).length ||
        [...this._drafts.values()].some((row) => row.saving || this._hasUnsavedReview(row));
    }
  }

  _saveReview(draft) {
    if (draft.saving) {
      return draft.promise;
    }
    if (!this._mounted || !this._admin || !this._getHass()?.user?.is_admin) {
      return Promise.resolve();
    }
    draft.saving = true;
    draft.error = '';
    this._updateReviewStatus(draft);
    // Serialize each clip independently. A second answer entered during the
    // first request is sent afterwards, with the latest pair of answers.
    draft.promise = (async () => {
      try {
        while (this._mounted && this._getHass()?.user?.is_admin && this._hasUnsavedReview(draft)) {
          const label = draft.label;
          const presence = draft.presence;
          await this._request(
            'label',
            { recording_id: draft.id, label, word_present: presence },
            draft.entityId
          );
          draft.savedLabel = label;
          draft.savedPresence = presence;
          draft.revision++;
          for (const item of this._items) {
            if (this._reviewKey(item) === draft.key) {
              item.label = label;
              item.word_present = presence;
            }
          }
          this._emittingReviewUpdate = true;
          try {
            emitRecordingsUpdated(draft.entityId);
          } finally {
            this._emittingReviewUpdate = false;
          }
        }
      } catch (error) {
        draft.error = error?.message || String(error);
      } finally {
        draft.saving = false;
        if (this._mounted) {
          this._updateReviewStatus(draft);
        }
      }
    })();
    return draft.promise;
  }

  async _play(item, target, entityId) {
    const scope = this._entity;
    const epoch = this._viewRevision;
    try {
      const data = await this._request('get', { recording_id: item.id }, entityId);
      if (
        !this._mounted ||
        scope !== this._entity ||
        epoch !== this._viewRevision ||
        !target.isConnected
      ) {
        return;
      }
      this._disposePlayers(target);
      const url = URL.createObjectURL(recordingBlob(data.audio_base64));
      this._urls.add(url);
      const audio = element('audio');
      audio.controls = true;
      audio.src = url;
      audio.setAttribute('aria-label', 'Saved wake recording');
      this._trackPlayer(audio, target, url);
      target.replaceChildren(audio);
      // Playback requires a user's explicit action; never auto-play a captured clip.
    } catch (error) {
      if (
        this._mounted &&
        scope === this._entity &&
        epoch === this._viewRevision &&
        target.isConnected
      ) {
        this._disposePlayers(target);
        target.textContent = `Unable to load recording: ${error?.message || String(error)}`;
      }
    }
  }

  _isPlaying() {
    return [...this._players.keys()].some((audio) => audio.paused === false);
  }

  _trackPlayer(audio, target, url) {
    const player = { target, url, heldSession: null, heldWakeWord: null, disposed: false };
    player.release = () => {
      const wakeWord = player.heldWakeWord;
      const session = player.heldSession;
      player.heldWakeWord = null;
      player.heldSession = null;
      if (!wakeWord) {
        return;
      }
      // Release this player's own reference only, even after the selected
      // satellite or session changes. TTS may still hold another reference.
      wakeWord.resumeFromPlayback();
      session.recordings?.review?.tick();
    };
    player.start = () => {
      if (player.disposed || player.heldWakeWord) {
        return;
      }
      // The local microphone hears playback even when reviewing a remote
      // satellite. Resolve the local session when Play is pressed, not on load.
      const session = this._getSession();
      const wakeWord = session?.wakeWord;
      if (
        typeof wakeWord?.suspendForPlayback !== 'function' ||
        typeof wakeWord?.resumeFromPlayback !== 'function'
      ) {
        return;
      }
      player.heldSession = session;
      player.heldWakeWord = wakeWord;
      wakeWord.suspendForPlayback();
      session.recordings?.review?.tick();
    };
    audio.addEventListener('play', player.start);
    for (const event of ['pause', 'ended', 'error']) {
      audio.addEventListener(event, player.release);
    }
    this._players.set(audio, player);
  }

  _disposePlayers(target) {
    for (const [audio, player] of this._players) {
      if (target && player.target !== target) {
        continue;
      }
      player.disposed = true;
      // Removing/replacing an audio element does not reliably stop playback.
      // Pause while it is still attached, then balance our hold explicitly in
      // case the browser delivers its pause event asynchronously.
      try {
        audio.pause();
      } finally {
        try {
          player.release();
        } finally {
          audio.removeEventListener('play', player.start);
          for (const event of ['pause', 'ended', 'error']) {
            audio.removeEventListener(event, player.release);
          }
          URL.revokeObjectURL(player.url);
          this._urls.delete(player.url);
          this._players.delete(audio);
        }
      }
    }
  }

  _download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = element('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async _downloadWav(item, entityId) {
    const scope = this._entity;
    const epoch = this._viewRevision;
    await this._runAction(
      async () => {
        const data = await this._request('get', { recording_id: item.id }, entityId);
        if (this._mounted && scope === this._entity && epoch === this._viewRevision) {
          this._download(
            recordingBlob(data.audio_base64),
            recordingFilename(item.id, item.entity_id)
          );
        }
      },
      { refresh: false }
    );
  }

  async _exportReviewedPage() {
    const epoch = this._viewRevision;
    await this._runAction(
      async (entityId) => {
        const pending = [...this._drafts.values()]
          .filter((row) => row.saving)
          .map((row) => row.promise);
        if (pending.length) {
          await Promise.all(pending);
        }
        if (!this._mounted || entityId !== this._entity || epoch !== this._viewRevision) {
          return;
        }
        if ([...this._drafts.values()].some((row) => this._hasUnsavedReview(row))) {
          throw new Error('Some reviews are not saved. Retry their saves before exporting.');
        }
        const items = reviewedItems(this._items).slice(0, PAGE_SIZE);
        const exported = [];
        for (const item of items) {
          if (!this._mounted || entityId !== this._entity || epoch !== this._viewRevision) {
            return;
          }
          const owner = item.entity_id || entityId;
          const data = await this._request('get', { recording_id: item.id }, owner);
          // Recheck the stored label: another admin may have changed it since listing.
          if (!reviewedItems([data.item]).length) {
            continue;
          }
          recordingBlob(data.audio_base64);
          exported.push({
            ...data.item,
            entity_id: owner,
            station_name: item.station_name,
            wav_filename: recordingFilename(data.item.id, item.entity_id),
            audio_base64: data.audio_base64,
          });
        }
        if (!this._mounted || entityId !== this._entity || epoch !== this._viewRevision) {
          return;
        }
        const manifest = {
          format: 'voice_satellite_reviewed_recordings_v1',
          entity_id: entityId,
          exported_at: new Date().toISOString(),
          scope: 'reviewed_items_on_displayed_page',
          label_policy:
            'Feedback and acoustic word presence are independent user labels. No automatic training label is inferred.',
          items: exported,
        };
        this._download(
          new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }),
          'reviewed-wake-recordings.json'
        );
      },
      { refresh: false }
    );
  }

  _render() {
    if (!this._mounted) {
      return;
    }
    this._disposePlayers();
    this._urls.forEach((url) => URL.revokeObjectURL(url));
    this._urls.clear();
    this._reviewViews.clear();
    this._exportButton = null;
    this._captureButton = null;
    this._captureStatus = null;
    const root = element('div', undefined, 'vsp-recordings');
    const style = element('style');
    style.textContent = RECORDINGS_PANEL_STYLES;
    root.append(style, element('h3', this._standalone ? 'Recordings inbox' : 'Wake recordings'));
    const description = this._standalone
      ? 'Listen, label, and export saved clips from your stations. Choosing a station here only filters the inbox.'
      : 'Save up to five seconds ending at a wake detection for later review. Audio stays in Home Assistant unless you export it. Recording is off by default.';
    root.appendChild(element('p', description, 'hint'));
    if (!this._admin) {
      root.appendChild(
        element(
          'p',
          'A Home Assistant administrator is required to change recording settings or review saved audio.'
        )
      );
    } else if (!this._entity && !this._standalone) {
      root.appendChild(element('p', 'Select a satellite to manage its recordings.'));
    } else {
      this._renderContent(root);
    }
    if (this._error) {
      const error = element('p', this._error, 'error');
      error.setAttribute('role', 'alert');
      root.appendChild(error);
    }
    this._host.replaceChildren(root);
    this._updateCaptureStatus();
  }

  _renderContent(root) {
    if (this._standalone) {
      this._renderStationSelector(root);
    }
    if (this._entity) {
      this._renderSettings(root);
      this._renderCaptureControls(root);
    } else {
      root.appendChild(
        element(
          'p',
          'Choose one station to change its recording settings. Audio stays in Home Assistant unless you export it.',
          'hint'
        )
      );
    }
    this._renderToolbar(root);
    if (this._loading) {
      root.appendChild(element('p', 'Loading recordings…'));
    } else if (!this._items.length) {
      root.appendChild(element('p', 'No recordings in this view.'));
    }
    for (const item of this._items) {
      root.appendChild(this._renderRecording(item));
    }
    this._renderPagination(root);
    if (this._busy) {
      root.querySelectorAll('button, select, input').forEach((node) => {
        node.disabled = true;
      });
    }
  }

  _renderStationSelector(root) {
    const stations = element('div', undefined, 'row');
    const choices = [
      ['', 'All stations'],
      ...this._stations.map((station) => [station.entity_id, station.name]),
    ];
    if (this._entity && !this._stations.some((station) => station.entity_id === this._entity)) {
      choices.push([this._entity, this._entity]);
    }
    const selector = select('Review recordings from station', choices, this._entity || '');
    selector.addEventListener('change', () => {
      this._selection = selector.value || null;
      this.update();
    });
    stations.append(element('span', 'Station'), selector);
    root.appendChild(stations);
  }

  _renderSettings(root) {
    const settings = element('div', undefined, 'row');
    const mode = select(
      'Recording mode',
      [
        ['off', 'Off'],
        ['save', 'Save'],
        ['review', 'Save + feedback'],
      ],
      this._config.mode
    );
    const retention = element('input');
    retention.type = 'number';
    retention.min = '1';
    retention.max = '365';
    retention.value = this._config.retention_days;
    retention.setAttribute('aria-label', 'Retention days');
    const quota = element('input');
    quota.type = 'number';
    quota.min = '1';
    quota.max = '2048';
    quota.value = this._config.max_storage_mb;
    quota.setAttribute('aria-label', 'Storage limit in MB');
    const apply = button('Apply settings', () => {
      const days = Number(retention.value);
      const mb = Number(quota.value);
      if (
        !Number.isInteger(days) ||
        !Number.isInteger(mb) ||
        !retention.checkValidity() ||
        !quota.checkValidity()
      ) {
        this._error = 'Enter valid whole-number retention and storage limits.';
        this._render();
        return;
      }
      this._configure(mode.value, days, mb);
    });
    apply.disabled = this._loading || !!this._error;
    settings.append(
      mode,
      element('span', 'Keep days'),
      retention,
      element('span', 'Limit MB'),
      quota,
      apply
    );
    root.append(
      settings,
      element(
        'p',
        'Save + feedback asks silently after the voice interaction finishes. Feedback and whether the wake word was actually spoken are recorded separately. Retention applies to reviewed and unreviewed clips; a full storage limit stops new saves.',
        'hint'
      )
    );
  }

  _renderCaptureControls(root) {
    const captureRow = element('div', undefined, 'row');
    this._captureButton = button('Capture missed wake', () =>
      this._runAction(async () => {
        const manager = this._localManager();
        if (!manager || manager.getStatus()?.available !== true || this._config.mode === 'off') {
          throw new Error('Capture is unavailable on this device');
        }
        await manager.captureMissed();
      })
    );
    this._captureStatus = element('span', '', 'hint');
    captureRow.append(this._captureButton, this._captureStatus);
    root.appendChild(captureRow);
  }

  _renderToolbar(root) {
    const tools = element('div', undefined, 'row');
    const filter = select(
      'Filter recording review state',
      [['', 'All recordings'], ...LABELS],
      this._filter
    );
    filter.addEventListener('change', () => {
      this._filter = filter.value;
      this._offset = 0;
      this.refresh();
    });
    const exportButton = button('Export reviewed page', () => this._exportReviewedPage());
    this._exportButton = exportButton;
    exportButton.disabled = !reviewedItems(this._items).length;
    tools.append(
      filter,
      button('Refresh', () => this.refresh()),
      exportButton
    );
    root.appendChild(tools);
    root.appendChild(
      element(
        'p',
        'Changes save automatically. Check for Saved below each recording. Export includes only saved reviews on this page.',
        'hint'
      )
    );
  }

  _durationDescription(duration, hasDiscontinuity) {
    let description = `${duration.toFixed(2)} s`;
    if (duration < 1) {
      description += ' · Short clip — limited audio context';
    } else if (hasDiscontinuity) {
      description += ' · Partial audio history';
    }
    return description;
  }

  _renderRecording(item) {
    const entityId = item.entity_id || this._entity;
    const row = element('article');
    const date = new Date(item.created_at);
    row.appendChild(
      element(
        'strong',
        Number.isNaN(date.getTime())
          ? String(item.created_at || 'Recording')
          : date.toLocaleString()
      )
    );
    if (this._standalone) {
      row.appendChild(element('div', item.station_name || entityId, 'hint'));
    }
    const metadata = item.metadata || {};
    row.appendChild(
      element(
        'div',
        [
          metadata.capture_kind === 'missed' ? 'Missed wake capture' : 'Wake detection',
          metadata.engine,
          metadata.model,
        ]
          .filter(Boolean)
          .join(' · '),
        'hint'
      )
    );
    const duration = Number(item.duration_seconds ?? metadata.pre_seconds);
    if (Number.isFinite(duration) && duration >= 0) {
      row.appendChild(
        element(
          'div',
          this._durationDescription(duration, metadata.discontinuity),
          duration < 1 ? 'hint short-clip' : 'hint'
        )
      );
    }
    const draft = this._reviewDraft(item);
    const fields = element('div', undefined, 'review-fields');
    const label = select('Wake feedback', LABELS, draft.label);
    const presence = select('Wake word present in recording', PRESENCE, draft.presence);
    const feedbackField = element('label', 'Was this an intended wake?');
    feedbackField.appendChild(label);
    const presenceField = element('label', 'Was the wake word spoken?');
    presenceField.appendChild(presence);
    fields.append(feedbackField, presenceField);
    const change = () => this._label(item, label.value, presence.value);
    label.addEventListener('change', change);
    presence.addEventListener('change', change);
    const saveRow = element('div', undefined, 'review-save');
    const retry = button('Save review', change);
    const status = element('span', '', 'review-status hint');
    status.setAttribute('role', 'status');
    saveRow.append(retry, status);
    this._reviewViews.set(draft.key, { status, retry });
    this._updateReviewStatus(draft);
    const controls = element('div', undefined, 'row');
    const player = element('div');
    controls.append(
      button('Listen', () => this._play(item, player, entityId)),
      button('Download WAV', () => this._downloadWav(item, entityId)),
      button('Delete', () => this._deleteRecording(item, entityId))
    );
    row.append(fields, saveRow, controls, player);
    return row;
  }

  _renderPagination(root) {
    const pages = element('div', undefined, 'row');
    const prev = button('Previous', () => {
      this._offset = Math.max(0, this._offset - PAGE_SIZE);
      this.refresh();
    });
    const next = button('Next', () => {
      this._offset += PAGE_SIZE;
      this.refresh();
    });
    prev.disabled = this._offset === 0;
    next.disabled = this._offset + PAGE_SIZE >= this._total;
    pages.append(
      prev,
      element(
        'span',
        `${this._items.length ? this._offset + 1 : 0}–${this._offset + this._items.length} of ${this._total}`
      ),
      next
    );
    root.appendChild(pages);
  }

  async _deleteRecording(item, entityId) {
    if (!window.confirm('Delete this saved recording and its review?')) {
      return;
    }
    const key = this._reviewKey(item);
    await this._runAction(async () => {
      // Let an in-flight label request settle before removing its recording.
      // Only confirmed deletion may discard the user's unsaved review draft.
      const draft = this._drafts.get(key);
      if (draft?.saving) {
        await draft.promise;
      }
      await this._request('delete', { recording_id: item.id }, entityId);
      this._drafts.delete(key);
      this._reviewViews.delete(key);
      emitRecordingsUpdated(entityId);
    });
  }

  destroy() {
    this._mounted = false;
    this._listRequestId += 1;
    this._viewRevision += 1;
    window.removeEventListener('voice-satellite-recordings-updated', this._onUpdated);
    this._disposePlayers();
    this._urls.forEach((url) => URL.revokeObjectURL(url));
    this._urls.clear();
    this._host.replaceChildren();
  }
}
