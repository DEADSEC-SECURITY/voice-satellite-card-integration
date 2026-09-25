/** Optional, silent feedback after Assist has finished. Dismissal changes no label. */
const READY_STATES = new Set(['IDLE', 'LISTENING']);
const MAX_QUEUE = 3;
const MAX_AGE_MS = 120000;
const VISIBLE_MS = 30000;

export function canShowRecordingReview(session) {
  return !!session && session.isStarted !== false && READY_STATES.has(session.currentState)
    && !session.wakeWord?.isPlaybackSuspended
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
    // A bottom card without a backdrop or focus trap leaves the next voice turn available.
    card.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:max(12px,env(safe-area-inset-bottom));z-index:10005;width:min(520px,calc(100% - 24px));max-height:calc(100vh - 24px);max-height:calc(100dvh - 24px);overflow:auto;box-sizing:border-box;padding:20px;border:1px solid var(--divider-color,#d7e1e8);border-radius:24px;background:var(--card-background-color,#fff);color:var(--primary-text-color,#222);box-shadow:0 8px 40px #0005;font:16px/1.4 var(--paper-font-body1_-_font-family,Arial,sans-serif);';
    const current = this._current;
    const generation = this._generation;
    const state = { step: 1, label: null, presence: null, saving: false, error: '' };
    const isCurrent = () => !this._destroyed && this._generation === generation && this._current === current;
    const touch = () => { current.shownAt = Date.now(); };
    const makeButton = (text, action, primary = false) => {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = text;
      button.style.cssText = `min-height:56px;box-sizing:border-box;padding:12px 16px;border:2px solid ${primary ? 'var(--primary-color,#0288d1)' : 'var(--divider-color,#c8d4dd)'};border-radius:14px;background:${primary ? 'var(--primary-color,#0288d1)' : 'var(--card-background-color,#fff)'};color:${primary ? 'var(--text-primary-color,#fff)' : 'var(--primary-text-color,#222)'};font:inherit;font-weight:600;line-height:1.35;cursor:pointer;touch-action:manipulation;`;
      button.disabled = state.saving;
      if (button.disabled) button.style.opacity = '0.55';
      button.addEventListener('click', () => {
        if (!isCurrent() || state.saving) return;
        touch();
        return action();
      });
      return button;
    };
    const save = async () => {
      if (!state.label || !state.presence) return;
      state.saving = true;
      state.error = '';
      render();
      try {
        await this._getHass().callWS({ type: 'voice_satellite/recordings/label',
          entity_id: current.item.entity_id, recording_id: current.item.id,
          label: state.label, word_present: state.presence });
        emitRecordingsUpdated(current.item.entity_id);
        if (isCurrent()) this._dismiss();
      } catch (failure) {
        if (!isCurrent()) return;
        state.saving = false;
        state.error = `Could not save. Your answers are still here. Try again. ${failure?.message || String(failure)}`;
        touch();
        render('save');
      }
    };
    const render = (focus = '') => {
      card.replaceChildren();
      card.setAttribute('aria-busy', String(state.saving));
      let focusTarget = null;
      const progress = document.createElement('p');
      progress.style.cssText = 'margin:0 0 8px;color:var(--secondary-text-color,#526573);font-size:14px;font-weight:600;';
      progress.textContent = `Wake feedback · ${state.step} of 2`;
      const recordedAt = current.item.metadata?.captured_at || current.item.created_at;
      if (recordedAt && !Number.isNaN(Date.parse(recordedAt))) {
        progress.textContent += ` · ${new Date(recordedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
      }
      const title = document.createElement('h2');
      title.style.cssText = 'margin:0 0 8px;font-size:24px;line-height:1.25;';
      title.textContent = state.step === 1 ? 'Did you mean to wake me?' : 'Was the wake word said?';
      title.tabIndex = -1;
      if (focus === 'heading') focusTarget = title;
      const hint = document.createElement('p');
      hint.style.cssText = 'margin:0 0 20px;color:var(--secondary-text-color,#526573);';
      hint.textContent = state.step === 1
        ? 'A quick check helps improve wake detection. You can also review this later.'
        : 'Count voices from a TV or someone else, too. Unsure is okay.';
      const choices = document.createElement('div');
      choices.setAttribute('role', 'group');
      choices.setAttribute('aria-label', title.textContent);
      choices.style.cssText = 'display:grid;gap:10px;';
      if (state.step === 1) {
        for (const [label, text] of [['correct', 'Yes, on purpose'], ['false_trigger', 'No, accidental wake'], ['unsure', "I'm not sure"]]) {
          choices.appendChild(makeButton(text, () => { state.label = label; state.step = 2; state.error = ''; render('heading'); }));
        }
      } else {
        for (const [presence, text] of [['present', 'Yes, I heard it'], ['absent', 'No, just other sounds'], ['uncertain', "I'm not sure"]]) {
          const button = makeButton(text, () => { state.presence = presence; state.error = ''; render('choice'); });
          button.setAttribute('aria-pressed', String(state.presence === presence));
          if (state.presence === presence) {
            button.style.borderColor = 'var(--primary-color,#0288d1)';
            button.style.boxShadow = 'inset 0 0 0 1px var(--primary-color,#0288d1)';
            if (focus === 'choice') focusTarget = button;
          }
          choices.appendChild(button);
        }
      }
      card.append(progress, title, hint, choices);
      if (state.step === 2) {
        const actions = document.createElement('div');
        actions.style.cssText = 'display:grid;grid-template-columns:1fr 2fr;gap:10px;margin-top:20px;';
        actions.appendChild(makeButton('Back', () => { state.step = 1; state.error = ''; render('heading'); }));
        const submit = makeButton(state.saving ? 'Saving…' : 'Save feedback', save, true);
        submit.style.padding = '12px';
        submit.disabled = state.saving || !state.presence;
        if (submit.disabled) submit.style.opacity = '0.55';
        if (focus === 'save') focusTarget = submit;
        actions.appendChild(submit);
        card.appendChild(actions);
      }
      const later = makeButton('Review later', () => this._dismiss());
      later.style.cssText += 'width:100%;margin-top:10px;border-color:transparent;background:transparent;color:var(--secondary-text-color,#526573);';
      card.appendChild(later);
      const status = document.createElement('div');
      status.setAttribute('role', 'status');
      status.style.cssText = 'color:var(--error-color,#b42318);overflow-wrap:anywhere;';
      status.textContent = state.error;
      card.appendChild(status);
      // Only move focus after a deliberate answer; never steal it when feedback first appears.
      focusTarget?.focus({ preventScroll: true });
    };
    render();
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
