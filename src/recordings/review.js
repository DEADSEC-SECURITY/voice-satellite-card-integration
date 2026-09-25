/** Optional, silent feedback after Assist has finished. Dismissal changes no label. */
const READY_STATES = new Set(['IDLE', 'LISTENING']);
const MAX_QUEUE = 3;
const MAX_AGE_MS = 120000;
const VISIBLE_MS = 30000;

export function canShowRecordingReview(session) {
  return !!session && session.isStarted !== false && READY_STATES.has(session.currentState)
    && !session.tts?.isPlaying && !session.announcement?.playing && !session.askQuestion?.playing
    && !session.startConversation?.playing && !session.timer?.alertActive && !session._followupDelayTimer;
}

export function emitRecordingsUpdated(entityId, configChanged = false) {
  window.dispatchEvent(new CustomEvent('voice-satellite-recordings-updated', {
    detail: { entity_id: entityId, ...(configChanged ? { config_changed: true } : {}) },
  }));
}

export class RecordingReviewPrompt {
  constructor({ getSession, getHass, getEntityId, host }) {
    this._getSession = getSession;
    this._getHass = getHass;
    this._getEntityId = getEntityId;
    this._host = host;
    this._queue = [];
    this._current = null;
    this._element = null;
    this._readySince = null;
    this._generation = 0;
    this._destroyed = false;
  }

  notify(item) {
    if (this._destroyed || !item?.id || item.metadata?.capture_kind === 'missed') return;
    const entityId = item.entity_id || this._getEntityId();
    if (!entityId || entityId !== this._getEntityId()) return;
    const capturedAt = Date.parse(item.metadata?.captured_at || item.created_at || '');
    if (Number.isFinite(capturedAt) && Date.now() - capturedAt >= MAX_AGE_MS) return;
    if (this._current?.item.id === item.id || this._queue.some(row => row.item.id === item.id)) return;
    this._queue.push({ item: { ...item, entity_id: entityId }, queuedAt: Date.now() });
    if (this._queue.length > MAX_QUEUE) this._queue.shift();
    this.tick();
  }

  tick() {
    if (this._destroyed) return;
    const now = Date.now();
    const entityId = this._getEntityId();
    this._queue = this._queue.filter(row => row.item.entity_id === entityId && now - row.queuedAt < MAX_AGE_MS);
    if (!this._getHass()?.user?.is_admin || !entityId) { this.clear(); return; }
    if (this._current && (this._current.item.entity_id !== entityId || now - this._current.shownAt >= VISIBLE_MS)) {
      this._dismiss();
    }
    if (!canShowRecordingReview(this._getSession())) {
      this._readySince = null;
      // A new interaction takes precedence; the skipped recording stays unreviewed.
      if (this._current) this._dismiss();
      return;
    }
    if (this._readySince === null) this._readySince = now;
    if (!this._current && this._queue.length && now - this._readySince >= 750 && now - this._queue[0].queuedAt >= 1000) {
      const next = this._queue.shift();
      this._current = { ...next, shownAt: now };
      this._show();
    }
  }

  _show() {
    const card = document.createElement('section');
    card.setAttribute('aria-label', 'Wake word feedback');
    card.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:10005;width:min(360px,calc(100vw - 32px));box-sizing:border-box;padding:16px;border-radius:12px;background:var(--card-background-color,#fff);color:var(--primary-text-color,#222);box-shadow:0 4px 24px #0005;font:14px sans-serif;';
    const title = document.createElement('strong');
    title.textContent = 'Was that wake-up intentional?';
    const hint = document.createElement('p');
    hint.textContent = 'Optional feedback. Skip leaves this recording unreviewed.';
    const recordedAt = this._current.item.metadata?.captured_at || this._current.item.created_at;
    if (recordedAt && !Number.isNaN(Date.parse(recordedAt))) {
      hint.textContent = `Wake at ${new Date(recordedAt).toLocaleTimeString()}. ${hint.textContent}`;
    }
    const presenceLabel = document.createElement('label');
    presenceLabel.textContent = 'Did the recording contain your wake word? ';
    const presence = document.createElement('select');
    presence.setAttribute('aria-label', 'Wake word present in recording');
    for (const [value, text] of [['uncertain', 'Not sure'], ['present', 'Present'], ['absent', 'Absent']]) {
      const option = document.createElement('option');
      option.value = value; option.textContent = text; presence.appendChild(option);
    }
    presence.value = 'uncertain';
    presenceLabel.appendChild(presence);
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;';
    const error = document.createElement('div');
    error.setAttribute('role', 'status');
    const makeButton = (text, action) => {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = text;
      button.style.cssText = 'min-height:40px;padding:6px 12px;cursor:pointer;';
      button.addEventListener('click', action);
      actions.appendChild(button);
      return button;
    };
    const feedbackButtons = [];
    for (const [label, text] of [['correct', 'Correct wake'], ['false_trigger', 'False wake'], ['unsure', 'Unsure']]) {
      feedbackButtons.push(makeButton(text, async () => {
        const current = this._current;
        if (!current) return;
        const generation = this._generation;
        feedbackButtons.forEach(button => { button.disabled = true; });
        try {
          await this._getHass().callWS({ type: 'voice_satellite/recordings/label',
            entity_id: current.item.entity_id, recording_id: current.item.id, label, word_present: presence.value });
          emitRecordingsUpdated(current.item.entity_id);
          if (generation === this._generation) this._dismiss();
        } catch (failure) {
          if (generation !== this._generation) return;
          error.textContent = `Feedback was not saved: ${failure?.message || String(failure)}`;
          feedbackButtons.forEach(button => { button.disabled = false; });
        }
      }));
    }
    makeButton('Skip', () => this._dismiss());
    card.append(title, hint, presenceLabel, actions, error);
    (this._host || document.body).appendChild(card);
    this._element = card;
  }

  _dismiss() {
    this._generation += 1;
    this._element?.remove();
    this._element = null;
    this._current = null;
  }

  clear() {
    this._queue = [];
    this._readySince = null;
    this._dismiss();
  }

  destroy() { this.clear(); this._destroyed = true; }
}
