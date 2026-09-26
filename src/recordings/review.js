/** Optional, silent feedback after Assist has finished. Dismissal changes no label. */
import { element } from './dom.js';
import { RECORDING_FEEDBACK_STYLES } from './styles.js';
const INTENT_CHOICES = [
  ['correct', 'Yes, on purpose'],
  ['false_trigger', 'No, accidental wake'],
  ['unsure', "I'm not sure"],
];
const PRESENCE_CHOICES = [
  ['present', 'Yes, I heard it'],
  ['absent', 'No, just other sounds'],
  ['uncertain', "I'm not sure"],
];
const IDLE_SETTLE_MS = 750;
const MIN_PROMPT_DELAY_MS = 1000;
const READY_STATES = new Set(['IDLE', 'LISTENING']);
const MAX_QUEUE = 3;
const MAX_AGE_MS = 120000;
const VISIBLE_MS = 30000;

export function canShowRecordingReview(session) {
  return (
    !!session &&
    session.isStarted !== false &&
    READY_STATES.has(session.currentState) &&
    !session.wakeWord?.isPlaybackSuspended &&
    !session.tts?.isPlaying &&
    !session.announcement?.playing &&
    !session.askQuestion?.playing &&
    !session.startConversation?.playing &&
    !session.timer?.alertActive &&
    !session._followupDelayTimer
  );
}

export function emitRecordingsUpdated(entityId, configChanged = false) {
  window.dispatchEvent(
    new CustomEvent('voice-satellite-recordings-updated', {
      detail: { entity_id: entityId, ...(configChanged ? { config_changed: true } : {}) },
    })
  );
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
    if (this._destroyed || !item?.id || item.metadata?.capture_kind === 'missed') {
      return;
    }
    const entityId = item.entity_id || this._getEntityId();
    if (!entityId || entityId !== this._getEntityId()) {
      return;
    }
    const capturedAt = Date.parse(item.metadata?.captured_at || item.created_at || '');
    if (Number.isFinite(capturedAt) && Date.now() - capturedAt >= MAX_AGE_MS) {
      return;
    }
    if (this._current?.item.id === item.id || this._queue.some((row) => row.item.id === item.id)) {
      return;
    }
    this._queue.push({ item: { ...item, entity_id: entityId }, queuedAt: Date.now() });
    if (this._queue.length > MAX_QUEUE) {
      this._queue.shift();
    }
    this.tick();
  }

  tick() {
    if (this._destroyed) {
      return;
    }
    const now = Date.now();
    const entityId = this._getEntityId();
    this._queue = this._queue.filter(
      (row) => row.item.entity_id === entityId && now - row.queuedAt < MAX_AGE_MS
    );
    if (!this._getHass()?.user?.is_admin || !entityId) {
      this.clear();
      return;
    }
    if (
      this._current &&
      (this._current.item.entity_id !== entityId || now - this._current.shownAt >= VISIBLE_MS)
    ) {
      this._dismiss();
    }
    if (!canShowRecordingReview(this._getSession())) {
      this._readySince = null;
      // A new interaction takes precedence; the skipped recording stays unreviewed.
      if (this._current) {
        this._dismiss();
      }
      return;
    }
    if (this._readySince === null) {
      this._readySince = now;
    }
    if (
      !this._current &&
      this._queue.length &&
      now - this._readySince >= IDLE_SETTLE_MS &&
      now - this._queue[0].queuedAt >= MIN_PROMPT_DELAY_MS
    ) {
      const next = this._queue.shift();
      this._current = { ...next, shownAt: now };
      this._show();
    }
  }

  _show() {
    const card = element('section', undefined, 'vsr-feedback');
    card.setAttribute('aria-label', 'Wake word feedback');
    this._element = card;
    this._form = {
      current: this._current,
      generation: this._generation,
      step: 1,
      label: null,
      presence: null,
      saving: false,
      error: '',
    };
    this._renderForm(this._form);
    (this._host || document.body).appendChild(card);
  }

  _isCurrentForm(form) {
    return (
      !this._destroyed && this._generation === form.generation && this._current === form.current
    );
  }

  _touchForm(form) {
    form.current.shownAt = Date.now();
  }

  _createButton(form, text, action, primary = false) {
    const className = primary ? 'vsr-feedback-button primary' : 'vsr-feedback-button';
    const button = element('button', text, className);
    button.type = 'button';
    button.disabled = form.saving;
    button.addEventListener('click', () => {
      // A delayed click or save response must not modify a newer prompt.
      if (!this._isCurrentForm(form) || form.saving) {
        return;
      }
      this._touchForm(form);
      return action();
    });
    return button;
  }

  async _saveForm(form) {
    if (!form.label || !form.presence) {
      return;
    }
    form.saving = true;
    form.error = '';
    this._renderForm(form);
    try {
      await this._getHass().callWS({
        type: 'voice_satellite/recordings/label',
        entity_id: form.current.item.entity_id,
        recording_id: form.current.item.id,
        label: form.label,
        word_present: form.presence,
      });
      emitRecordingsUpdated(form.current.item.entity_id);
      if (this._isCurrentForm(form)) {
        this._dismiss();
      }
    } catch (error) {
      if (!this._isCurrentForm(form)) {
        return;
      }
      form.saving = false;
      form.error =
        'Could not save. Your answers are still here. Try again. ' +
        (error?.message || String(error));
      this._touchForm(form);
      this._renderForm(form, 'save');
    }
  }

  _renderProgress(form) {
    const progress = element(
      'p',
      'Wake feedback · ' + form.step + ' of 2',
      'vsr-feedback-progress'
    );
    const item = form.current.item;
    const recordedAt = item.metadata?.captured_at || item.created_at;
    if (recordedAt && !Number.isNaN(Date.parse(recordedAt))) {
      progress.textContent +=
        ' · ' + new Date(recordedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    return progress;
  }

  _renderChoices(form, title, focus) {
    const choices = element('div', undefined, 'vsr-feedback-choices');
    choices.setAttribute('role', 'group');
    choices.setAttribute('aria-label', title);
    let focusTarget = null;
    if (form.step === 1) {
      for (const [label, text] of INTENT_CHOICES) {
        choices.appendChild(
          this._createButton(form, text, () => {
            form.label = label;
            form.step = 2;
            form.error = '';
            this._renderForm(form, 'heading');
          })
        );
      }
    } else {
      for (const [presence, text] of PRESENCE_CHOICES) {
        const button = this._createButton(form, text, () => {
          form.presence = presence;
          form.error = '';
          this._renderForm(form, 'choice');
        });
        const selected = form.presence === presence;
        button.setAttribute('aria-pressed', String(selected));
        if (selected && focus === 'choice') {
          focusTarget = button;
        }
        choices.appendChild(button);
      }
    }
    return { choices, focusTarget };
  }

  _renderActions(form) {
    const actions = element('div', undefined, 'vsr-feedback-actions');
    const back = this._createButton(form, 'Back', () => {
      form.step = 1;
      form.error = '';
      this._renderForm(form, 'heading');
    });
    const submit = this._createButton(
      form,
      form.saving ? 'Saving…' : 'Save feedback',
      () => this._saveForm(form),
      true
    );
    submit.disabled = form.saving || !form.presence;
    actions.append(back, submit);
    return { actions, submit };
  }

  _renderForm(form, focus = '') {
    const card = this._element;
    card.replaceChildren();
    card.setAttribute('aria-busy', String(form.saving));
    const style = element('style', RECORDING_FEEDBACK_STYLES);
    const title = element(
      'h2',
      form.step === 1 ? 'Did you mean to wake me?' : 'Was the wake word said?'
    );
    title.tabIndex = -1;
    const hint = element(
      'p',
      form.step === 1
        ? 'A quick check helps improve wake detection. You can also review this later.'
        : 'Count voices from a TV or someone else, too. Unsure is okay.',
      'vsr-feedback-hint'
    );
    const { choices, focusTarget: selectedChoice } = this._renderChoices(
      form,
      title.textContent,
      focus
    );
    let focusTarget = focus === 'heading' ? title : selectedChoice;
    card.append(style, this._renderProgress(form), title, hint, choices);
    if (form.step === 2) {
      const { actions, submit } = this._renderActions(form);
      if (focus === 'save') {
        focusTarget = submit;
      }
      card.appendChild(actions);
    }
    const later = this._createButton(form, 'Review later', () => this._dismiss());
    later.className += ' later';
    const status = element('div', form.error, 'vsr-feedback-status');
    status.setAttribute('role', 'status');
    card.append(later, status);
    // Only move focus after a deliberate answer; never steal it on arrival.
    focusTarget?.focus({ preventScroll: true });
  }

  _dismiss() {
    this._generation += 1;
    this._element?.remove();
    this._element = null;
    this._current = null;
    this._form = null;
  }

  clear() {
    this._queue = [];
    this._readySince = null;
    this._dismiss();
  }

  destroy() {
    this.clear();
    this._destroyed = true;
  }
}
