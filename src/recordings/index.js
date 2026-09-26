/** Optional local wake recordings. Upload failure never blocks the voice turn. */
import { VERSION } from '../constants.js';
import { resolveDspForMode } from '../audio/dsp-config.js';
import { getSwitchState } from '../shared/satellite-state.js';
import { PcmCaptureRing, SAMPLE_RATE, captureId, toBase64 } from './capture.js';
import { RecordingReviewPrompt } from './review.js';
const MAX_PENDING = 20;
const API = 'voice_satellite/recordings/';
const UPDATE_INTERVAL_MS = 5000;
const POLICY_REFRESH_INTERVAL_MS = 30000;

export class TriggerRecorder {
  constructor(session) {
    this.session = session;
    this.config = { mode: 'off', retention_days: 7, max_storage_mb: 250 };
    this.entity = null;
    this.ring = null;
    this.pending = [];
    this.dropped = 0;
    this.error = null;
    this.nativeAvailable = false;
    this.nativeEnabled = null;
    this.nativeDropped = 0;
    this._policyKnown = false;
    this._clearNativePending = false;
    this._appliedNativeConfigKey = null;
    this._nativeConfigError = null;
    this.listeners = new Set();
    this._nextRefresh = 0;
    this._epoch = 0;
    this._sessionId = null;
    this._timer = null;
    this._nativePolling = false;
    this.review = new RecordingReviewPrompt({
      getSession: () => this.session,
      getHass: () => this.session.hass,
      getEntityId: () => this.entity,
    });
    this._changed = (event) => {
      if (event.detail?.entity_id === this.entity && event.detail?.config_changed) {
        this._nextRefresh = 0;
        this.update();
      }
    };
    this._nativeReady = () => {
      void this.pollNative();
    };
    window.addEventListener('voice-satellite-recordings-updated', this._changed);
    window.addEventListener('kiosksatellite:wakeword-recording', this._nativeReady);
  }

  get enabled() {
    return this.config.mode !== 'off';
  }

  get native() {
    return this.session._nativeWakeActive === true;
  }

  get muted() {
    return this.session._muted || getSwitchState(this.session.hass, this.entity, 'mute');
  }

  getStatus() {
    return {
      mode: this.config.mode,
      enabled: this.enabled,
      available:
        this.enabled &&
        !this.muted &&
        (this.native
          ? this.nativeAvailable && this.nativeEnabled
          : !!this.ring?.total && this.session.wakeWord?._active !== false),
      native: this.native,
      pending: this.pending.length,
      dropped: this.dropped + this.nativeDropped,
      error: this.error,
    };
  }

  subscribe(callback) {
    this.listeners.add(callback);
    callback(this.getStatus());
    return () => this.listeners.delete(callback);
  }

  _notify() {
    for (const callback of this.listeners) {
      try {
        callback(this.getStatus());
      } catch (_) {
        /* isolated UI */
      }
    }
  }

  _failed(error) {
    const message = error?.message || String(error);
    if (message !== this.error) {
      this.session.logger?.log('recordings', message);
    }
    this.error = message;
    this._notify();
  }

  _call(command, data = {}, entity = this.entity) {
    const message = { type: API + command, entity_id: entity, ...data };
    if (this.session.hass?.callWS) {
      return this.session.hass.callWS(message);
    }
    return this.session.connection.sendMessagePromise(message);
  }

  update() {
    const entity = this.session.config.satellite_entity;
    if (entity !== this.entity) {
      this.stop(!!this.entity);
      this.entity = entity;
      this._sessionId = null;
    }
    if (!entity || !this.session.hass) {
      return;
    }
    if (!this._timer) {
      this._timer = setInterval(() => this.update(), UPDATE_INTERVAL_MS);
    }
    if (Date.now() >= this._nextRefresh) {
      void this.refreshConfig().catch((e) => this._failed(e));
    }
    void this.syncNative();
    if (this.enabled) {
      void this.flush();
    }
    this.review.tick();
  }

  async refreshConfig() {
    if (this._refreshing) {
      return this._refreshing;
    }
    const entity = this.entity || this.session.config.satellite_entity;
    if (!entity) {
      return this.config;
    }
    const epoch = this._epoch;
    this._nextRefresh = Date.now() + POLICY_REFRESH_INTERVAL_MS;
    this._refreshing = (async () => {
      const config = await this._call('config', {}, entity);
      if (epoch === this._epoch && entity === this.entity) {
        await this._applyConfig(config);
      }
      return config;
    })();
    try {
      return await this._refreshing;
    } finally {
      this._refreshing = null;
    }
  }

  async configure(config) {
    const entity = this.entity || this.session.config.satellite_entity;
    const saved = await this._call('configure', config, entity);
    if (entity === this.entity) {
      await this._applyConfig(saved);
    }
    return saved;
  }

  async _applyConfig(config) {
    const oldMode = this.config.mode;
    this.config = config;
    this._policyKnown = true;
    this._clearNativePending = !this.enabled;
    if (!this.enabled) {
      this._epoch++;
      this.ring = null;
      this.dropped += this.pending.length;
      this.pending = [];
      this.review.clear();
    } else if (!this.native && !this.ring) {
      this.ring = new PcmCaptureRing();
    }
    if (oldMode === 'review' && config.mode !== 'review') {
      this.review.clear();
    }
    this.error = null;
    await this.syncNative();
    this._notify();
  }

  async syncNative() {
    const api = window.kioskSatellite;
    const shouldRecord = this.enabled && this.native && !this.muted;
    // A temporary suspension or page reload must not erase unacknowledged clips.
    // Only an explicit Off policy or device switch clears that native queue.
    const clearPending = this._clearNativePending || (this._policyKnown && !this.enabled);
    const owner = this.entity ? `${window.location?.origin || ''}|${this.entity}` : null;
    const configurationKey = `${shouldRecord}:${clearPending}:${owner || ''}`;
    if (typeof api?.configureWakeWordRecording !== 'function') {
      this.nativeAvailable = false;
      if (shouldRecord) {
        this._failed(new Error('This Kiosk Satellite version cannot save native wake recordings.'));
      }
      return;
    }
    if (this._nativeConfiguring) {
      this._nativeSyncRequested = true;
      return;
    }
    if (configurationKey !== this._appliedNativeConfigKey) {
      this._nativeConfiguring = true;
      try {
        const result = await api.configureWakeWordRecording({
          enabled: shouldRecord,
          clear_pending: clearPending,
          ...(owner ? { owner } : {}),
        });
        // The app bridge returns null when it cannot deliver a command. Keep
        // that request retryable; a missing acknowledgement is not success.
        if (typeof result?.available !== 'boolean' || typeof result?.enabled !== 'boolean') {
          throw new Error(
            'The tablet did not acknowledge recording settings. Retrying automatically.'
          );
        }
        if (result.available && result.enabled !== shouldRecord) {
          throw new Error('The tablet has not applied recording settings. Retrying automatically.');
        }
        this._appliedNativeConfigKey = configurationKey;
        this.nativeAvailable = result?.available === true;
        this.nativeEnabled = result?.enabled === true;
        if (this.error === this._nativeConfigError) {
          this.error = null;
        }
        this._nativeConfigError = null;
        if (this.nativeEnabled) {
          this.ring = null;
        } else if (this.enabled && !this.native && !this.ring) {
          this.ring = new PcmCaptureRing();
        }
        this._notify();
      } catch (error) {
        this._appliedNativeConfigKey = null;
        this._nativeConfigError = error?.message || String(error);
        this._failed(error);
      } finally {
        this._nativeConfiguring = false;
        if (this._nativeSyncRequested) {
          this._nativeSyncRequested = false;
          void this.syncNative();
        }
      }
    }
    if (this.enabled && this.native && this.nativeAvailable && this.nativeEnabled && !this.muted) {
      await this.pollNative();
    }
  }

  feedAudio(samples) {
    if (!this.enabled || this.native || this.muted) {
      return null;
    }
    if (!this.ring) {
      this.ring = new PcmCaptureRing();
    }
    return this.ring.append(samples);
  }

  resetAudio() {
    this.ring?.reset();
  }

  markGap(marker) {
    this.ring?.markGap(marker);
  }

  _metadata(result, snapshot, kind) {
    const wake = this.session.wakeWord;
    if (!this._sessionId) {
      this._sessionId = captureId();
    }
    const model = result?.model || wake?.getModelName?.();
    const metadata = {
      origin: 'browser',
      engine: wake?.getEngine?.() || 'unknown',
      model: model || 'unknown',
      session_id: this._sessionId,
      captured_at: new Date().toISOString(),
      sample_rate: SAMPLE_RATE,
      trigger_sample: snapshot.count,
      pre_seconds: snapshot.count / SAMPLE_RATE,
      capture_kind: kind,
      version: VERSION,
      discontinuity: snapshot.discontinuity,
      microphone_settings: resolveDspForMode(this.session.config, 'wake_word'),
    };
    if (Number.isFinite(result?.score)) {
      metadata.score = result.score;
    }
    const threshold = result?.cutoff ?? wake?.getThresholdForModel?.(model);
    if (Number.isFinite(threshold)) {
      metadata.threshold = threshold;
    }
    const sensitivity = wake?._getSensitivityLabel?.();
    if (sensitivity) {
      metadata.sensitivity = sensitivity;
    }
    return metadata;
  }

  captureDetection(result, marker) {
    if (!this.enabled || this.native || this.muted) {
      return null;
    }
    try {
      const snapshot = this.ring?.snapshot(marker);
      if (!snapshot) {
        this._failed(
          new Error('Wake recording unavailable: triggering audio is outside the capture history.')
        );
        return null;
      }
      return this._enqueue({
        capture_id: captureId(),
        audio_base64: toBase64(snapshot.wav),
        metadata: this._metadata(result, snapshot, 'wake'),
      });
    } catch (e) {
      this._failed(e);
      return null;
    }
  }

  async captureMissed() {
    if (!this.enabled || this.muted) {
      throw new Error('Wake recording is not enabled or the microphone is muted.');
    }
    if (this.native) {
      if (!this.nativeAvailable) {
        throw new Error('Native recording is unavailable in this app version.');
      }
      const result = await window.kioskSatellite.captureWakeWordRecording();
      if (!result?.capture_id) {
        throw new Error('No recent wake-listening audio is available.');
      }
      await this.pollNative();
      return result;
    }
    const snapshot = this.session.wakeWord?._active === false ? null : this.ring?.snapshot();
    if (!snapshot) {
      throw new Error('No recent wake-listening audio is available.');
    }
    const id = this._enqueue({
      capture_id: captureId(),
      audio_base64: toBase64(snapshot.wav),
      metadata: this._metadata(null, snapshot, 'missed'),
    });
    if (!id) {
      throw new Error(this.error || 'Recording queue is full.');
    }
    return { capture_id: id };
  }

  _enqueue(capture, native = false) {
    if (this.pending.some((item) => item.capture_id === capture.capture_id)) {
      return capture.capture_id;
    }
    if (this.pending.length >= MAX_PENDING) {
      if (!native) {
        this.dropped++;
      }
      this._failed(
        new Error('Recording upload queue is full. Review connection and storage status.')
      );
      return null;
    }
    this.pending.push({ ...capture, entity_id: this.entity, native, savedId: null });
    this._notify();
    // Upload asynchronously; the normal wake handler never awaits the network.
    void Promise.resolve().then(() => this.flush());
    return capture.capture_id;
  }

  async pollNative() {
    if (!this.enabled || !this.native || !this.nativeAvailable || this._nativePolling) {
      return;
    }
    this._nativePolling = true;
    const epoch = this._epoch;
    try {
      const api = window.kioskSatellite;
      const list = await api.listWakeWordRecordings();
      if (epoch !== this._epoch) {
        return;
      }
      this.nativeDropped = Number(list?.dropped) || 0;
      for (const entry of list?.items || []) {
        if (this.pending.length >= MAX_PENDING) {
          break;
        }
        if (this.pending.some((item) => item.capture_id === entry.capture_id)) {
          continue;
        }
        const clip = await api.getWakeWordRecording({ capture_id: entry.capture_id });
        if (epoch !== this._epoch || !this.enabled) {
          return;
        }
        if (clip?.capture_id && clip.audio_base64) {
          this._enqueue(clip, true);
        }
      }
      this._notify();
    } catch (e) {
      this._failed(e);
    } finally {
      this._nativePolling = false;
    }
  }

  async flush() {
    if (this._flushing || !this.enabled || !this.pending.length) {
      return;
    }
    this._flushing = true;
    const epoch = this._epoch;
    try {
      while (this.enabled && epoch === this._epoch && this.pending.length) {
        const item = this.pending[0];
        if (item.entity_id !== this.entity) {
          break;
        }
        if (!item.savedId) {
          const result = await this._call(
            'save',
            {
              capture_id: item.capture_id,
              audio_base64: item.audio_base64,
              metadata: item.metadata,
            },
            item.entity_id
          );
          if (!result?.id) {
            throw new Error('Home Assistant did not acknowledge recording persistence.');
          }
          item.savedId = result.id;
        }
        if (epoch !== this._epoch) {
          return;
        }
        if (item.native) {
          const acknowledged = await window.kioskSatellite.ackWakeWordRecording({
            capture_id: item.capture_id,
          });
          if (acknowledged !== true) {
            throw new Error('Recording saved, but native acknowledgement failed; it will retry.');
          }
        }
        if (epoch !== this._epoch) {
          return;
        }
        this.pending.shift();
        this.error = null;
        if (this.config.mode === 'review' && this.session.hass?.user?.is_admin) {
          this.review.notify({
            id: item.savedId,
            entity_id: item.entity_id,
            metadata: item.metadata,
          });
        }
        window.dispatchEvent(
          new CustomEvent('voice-satellite-recordings-updated', {
            detail: { entity_id: item.entity_id },
          })
        );
        this._notify();
      }
    } catch (e) {
      this._failed(e);
    } finally {
      this._flushing = false;
    }
  }

  stop(clearPending = false) {
    this._epoch++;
    if (this._timer) {
      clearInterval(this._timer);
    }
    this._timer = null;
    this._nextRefresh = 0;
    this.ring = null;
    this.dropped += this.pending.length;
    this.pending = [];
    this.config = { ...this.config, mode: 'off' };
    this._policyKnown = false;
    this._clearNativePending = clearPending;
    this.review.clear();
    void this.syncNative();
    this._notify();
  }

  destroy() {
    this.stop();
    this.review.destroy();
    window.removeEventListener('voice-satellite-recordings-updated', this._changed);
    window.removeEventListener('kiosksatellite:wakeword-recording', this._nativeReady);
    this.listeners.clear();
  }
}
