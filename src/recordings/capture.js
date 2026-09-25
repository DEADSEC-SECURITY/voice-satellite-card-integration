/** Bounded, sample-addressed microphone history. Never changes detector input. */
export const SAMPLE_RATE = 16000;
let nextGeneration = 0;

export class PcmCaptureRing {
  constructor(seconds = 10) {
    this.samples = new Float32Array(Math.round(seconds * SAMPLE_RATE));
    this.total = 0;
    this.generation = nextGeneration++;
    this.lastGap = -1;
  }

  reset() {
    this.samples.fill(0);
    this.total = 0;
    this.lastGap = -1;
    this.generation = nextGeneration++;
  }

  append(samples) {
    const initial = Math.max(0, samples.length - this.samples.length);
    for (let i = initial; i < samples.length; i++) {
      const value = samples[i];
      this.samples[(this.total + i) % this.samples.length] = Number.isFinite(value) ? value : 0;
      if (!Number.isFinite(value)) this.lastGap = this.total + i;
    }
    this.total += samples.length;
    return { end: this.total, generation: this.generation };
  }

  markGap(marker) {
    if (!marker) this.lastGap = this.total;
    else if (marker.generation === this.generation) this.lastGap = marker.end - 1;
  }

  snapshot(marker = { end: this.total, generation: this.generation }, seconds = 5) {
    if (!marker || marker.generation !== this.generation || !Number.isInteger(marker.end)
        || marker.end > this.total || marker.end <= 0) return null;
    const oldest = Math.max(0, this.total - this.samples.length);
    // An inference frame older than our history must never capture newer audio.
    if (marker.end <= oldest) return null;
    const wanted = Math.max(0, marker.end - Math.round(seconds * SAMPLE_RATE));
    const start = Math.max(wanted, oldest);
    const count = marker.end - start;
    const output = new Float32Array(count);
    for (let i = 0; i < count; i++) output[i] = this.samples[(start + i) % this.samples.length];
    return {
      wav: encodeWav(output), count,
      discontinuity: start > wanted || (this.lastGap >= start && this.lastGap < marker.end),
    };
  }
}

export function encodeWav(samples) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset, value) => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); };
  ascii(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true);
  ascii(8, 'WAVE'); ascii(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true); view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const value = Number.isFinite(samples[i]) ? samples[i] : 0;
    view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(value * 32768))), true);
  }
  return bytes;
}

export function toBase64(bytes) {
  let binary = '';
  for (let first = 0; first < bytes.length; first += 8192) {
    binary += String.fromCharCode(...bytes.subarray(first, first + 8192));
  }
  return btoa(binary);
}

export function captureId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (v) => v.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
