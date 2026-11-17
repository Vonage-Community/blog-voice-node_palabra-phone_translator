// Both Vonage WebSockets and Palabra use 16-bit mono PCM at 24 kHz, so no resampling is needed.
export const SAMPLE_RATE = 24_000;

// Vonage expects one 20 ms frame per WebSocket message: 24,000 samples/s × 2 bytes × 0.02 s.
export const FRAME_BYTES = 960;

// Palabra recommends sending input in 320 ms chunks.
export const PALABRA_CHUNK_BYTES = FRAME_BYTES * 16;

// Splits a stream of PCM buffers into fixed-size pieces, keeping any remainder for the next call.
export class Chunker {
  constructor(size) {
    this.size = size;
    this.pending = Buffer.alloc(0);
  }

  push(buffer) {
    this.pending = Buffer.concat([this.pending, buffer]);
    const chunks = [];
    while (this.pending.length >= this.size) {
      chunks.push(this.pending.subarray(0, this.size));
      this.pending = this.pending.subarray(this.size);
    }
    return chunks;
  }

  flush() {
    const rest = this.pending;
    this.pending = Buffer.alloc(0);
    return rest;
  }
}

// Mixes the original voice into the translated frame at a lower volume.
// Either input may be missing; the result is always one full frame.
export function mixFrames(translated, original, originalGain) {
  const out = Buffer.alloc(FRAME_BYTES);
  for (let i = 0; i < FRAME_BYTES; i += 2) {
    const a = translated && i + 1 < translated.length ? translated.readInt16LE(i) : 0;
    const b = original && i + 1 < original.length ? original.readInt16LE(i) : 0;
    const sample = Math.round(a + b * originalGain);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i);
  }
  return out;
}

// The US ringback tone: 440 Hz and 480 Hz together, 2 seconds on and 4 seconds off.
// Played to the caller while the other phone rings, so the wait doesn't sound like a dead line.
const RINGBACK_CYCLE_FRAMES = 300; // 6 seconds of 20 ms frames
const RINGBACK_ON_FRAMES = 100; // the first 2 seconds of each cycle
const RINGBACK_AMPLITUDE = 3_000; // per tone, well below full scale

export function ringbackFrame(frameNumber) {
  const frame = Buffer.alloc(FRAME_BYTES);
  if (frameNumber % RINGBACK_CYCLE_FRAMES >= RINGBACK_ON_FRAMES) return frame;

  const samplesPerFrame = FRAME_BYTES / 2;
  for (let i = 0; i < samplesPerFrame; i++) {
    const t = (frameNumber * samplesPerFrame + i) / SAMPLE_RATE;
    const sample = RINGBACK_AMPLITUDE
      * (Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 480 * t));
    frame.writeInt16LE(Math.round(sample), i * 2);
  }
  return frame;
}
