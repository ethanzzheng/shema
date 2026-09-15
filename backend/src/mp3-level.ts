/**
 * Read-only loudness estimate for an MP3 clip, without decoding it.
 *
 * ElevenLabs occasionally returns a clip far below the level of its neighbours
 * — almost always a very short utterance ("Amen."), which lands in the pews as
 * a whisper or as nothing at all. To react to that we need the clip's level,
 * and the deploy has no ffmpeg, so decoding is not available.
 *
 * Layer III carries `global_gain` in each granule's side info: the quantiser
 * step the decoder applies to that granule. It is a direct, cheap proxy for
 * how loud the granule will come out — one step is roughly 1.5 dB — and it can
 * be read straight from the header bits without touching the Huffman data.
 *
 * Deliberately read-only. Rewriting global_gain (what mp3gain does) would let
 * us correct a clip in place, but a parsing mistake would then corrupt real
 * audio; here the worst case is a wrong number, and callers treat null as
 * "don't know" and leave the clip alone.
 */

interface FrameInfo {
  /** Byte length of this frame, including the header. */
  length: number;
  /** Bit offset of the first granule's global_gain, from the frame start. */
  gainOffsets: number[];
}

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const RATES_V1 = [44100, 48000, 32000, 0];
const RATES_V2 = [22050, 24000, 16000, 0];
const RATES_V25 = [11025, 12000, 8000, 0];

/** Read `n` bits starting at absolute bit position `pos`. */
function bits(buf: Buffer, pos: number, n: number): number {
  let v = 0;
  for (let i = 0; i < n; i++) {
    const p = pos + i;
    const byte = buf[p >> 3];
    if (byte === undefined) return -1;
    v = (v << 1) | ((byte >> (7 - (p & 7))) & 1);
  }
  return v;
}

/** Parse one frame header at `off`, or null if it is not a valid Layer III frame. */
function parseFrame(buf: Buffer, off: number): FrameInfo | null {
  if (off + 4 > buf.length) return null;
  if (buf[off] !== 0xff || (buf[off + 1] & 0xe0) !== 0xe0) return null;

  const verBits = (buf[off + 1] >> 3) & 0x03; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  const layer = (buf[off + 1] >> 1) & 0x03; // 1 = Layer III
  if (layer !== 1 || verBits === 1) return null;

  const crc = (buf[off + 1] & 0x01) === 0; // 0 means CRC PRESENT
  const brIdx = (buf[off + 2] >> 4) & 0x0f;
  const srIdx = (buf[off + 2] >> 2) & 0x03;
  const padding = (buf[off + 2] >> 1) & 0x01;
  const chanMode = (buf[off + 3] >> 6) & 0x03; // 3 = mono
  if (brIdx === 0 || brIdx === 15 || srIdx === 3) return null;

  const isV1 = verBits === 3;
  const bitrate = (isV1 ? BITRATES_V1_L3 : BITRATES_V2_L3)[brIdx] * 1000;
  const rate = (verBits === 3 ? RATES_V1 : verBits === 2 ? RATES_V2 : RATES_V25)[srIdx];
  if (!bitrate || !rate) return null;

  const samples = isV1 ? 1152 : 576;
  const length = Math.floor((samples / 8) * (bitrate / rate)) + padding;
  if (length < 24 || off + length > buf.length) return null;

  const mono = chanMode === 3;
  const channels = mono ? 1 : 2;
  // Side info begins after the header and the optional 2-byte CRC.
  const sideStart = (off + 4 + (crc ? 2 : 0)) * 8;

  // Layer III side info. MPEG1 has two granules and a scfsi field; the low
  // sampling-rate versions have one granule and none.
  const gainOffsets: number[] = [];
  if (isV1) {
    const header = 9 + (mono ? 5 : 3) + (mono ? 4 : 8);
    const granuleBits = 59;
    for (let g = 0; g < 2; g++) {
      for (let ch = 0; ch < channels; ch++) {
        gainOffsets.push(sideStart + header + (g * channels + ch) * granuleBits + 12 + 9);
      }
    }
  } else {
    const header = 8 + (mono ? 1 : 2);
    const granuleBits = 63;
    for (let ch = 0; ch < channels; ch++) {
      gainOffsets.push(sideStart + header + ch * granuleBits + 12 + 9);
    }
  }
  return { length, gainOffsets };
}

export interface Mp3Level {
  /** Mean global_gain across every granule in the clip. */
  meanGain: number;
  /**
   * Loudest granule in the clip. Stands in for peak amplitude: raising a clip
   * by its mean alone clips dynamic speech, because a quiet average can still
   * carry a loud syllable.
   */
  maxGain: number;
  frames: number;
  granules: number;
}

/**
 * Mean global_gain over a whole clip, or null when the buffer does not parse
 * as MP3 — in which case the caller should leave the clip alone rather than
 * act on a guess.
 */
export function mp3Level(buf: Buffer): Mp3Level | null {
  let off = 0;
  // Skip an ID3v2 tag if present.
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    const size =
      ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    off = 10 + size;
  }

  let frames = 0;
  let total = 0;
  let granules = 0;
  let misses = 0;
  let maxGain = 0;
  while (off < buf.length - 4) {
    const f = parseFrame(buf, off);
    if (!f) {
      off++;
      if (++misses > 4096 && frames === 0) return null; // not MP3 at all
      continue;
    }
    for (const bitPos of f.gainOffsets) {
      const g = bits(buf, bitPos, 8);
      if (g >= 0) {
        total += g;
        granules++;
        if (g > maxGain) maxGain = g;
      }
    }
    frames++;
    off += f.length;
  }
  if (!frames || !granules) return null;
  return { meanGain: total / granules, maxGain, frames, granules };
}

/** One global_gain step is about 1.5 dB. */
export const DB_PER_GAIN_STEP = 1.5;

/** Write `n` bits of `value` at absolute bit position `pos`. */
function setBits(buf: Buffer, pos: number, n: number, value: number): void {
  for (let i = 0; i < n; i++) {
    const p = pos + i;
    const byteIdx = p >> 3;
    if (byteIdx >= buf.length) return;
    const bit = (value >> (n - 1 - i)) & 1;
    const mask = 1 << (7 - (p & 7));
    if (bit) buf[byteIdx] |= mask;
    else buf[byteIdx] &= ~mask;
  }
}

/**
 * Raise (or lower) a whole clip by `steps` quantiser steps, losslessly.
 *
 * This is what mp3gain does: global_gain is the exponent the decoder applies
 * when it requantises a granule, so adding to it scales the output without
 * touching the Huffman-coded spectrum. No decode, no re-encode, no ffmpeg —
 * which matters because the deploy has none — and no generational loss.
 *
 * Returns a NEW buffer; the input is never mutated. Returns null if the clip
 * does not parse or if any granule would clip past the 8-bit field, so a
 * partial rewrite can never be emitted.
 */
export function mp3ApplyGain(buf: Buffer, steps: number): Buffer | null {
  if (!Number.isFinite(steps) || steps === 0) return null;
  const out: Buffer = Buffer.alloc(buf.length);
  buf.copy(out);

  let off = 0;
  if (out.length > 10 && out.toString('latin1', 0, 3) === 'ID3') {
    const size =
      ((out[6] & 0x7f) << 21) | ((out[7] & 0x7f) << 14) | ((out[8] & 0x7f) << 7) | (out[9] & 0x7f);
    off = 10 + size;
  }

  // Collect every granule first: if even one would saturate, change nothing.
  // A clip that came back half-raised is worse than one left alone.
  const edits: { pos: number; value: number }[] = [];
  let frames = 0;
  let misses = 0;
  while (off < out.length - 4) {
    const f = parseFrame(out, off);
    if (!f) {
      off++;
      if (++misses > 4096 && frames === 0) return null;
      continue;
    }
    for (const bitPos of f.gainOffsets) {
      const g = bits(out, bitPos, 8);
      if (g < 0) return null;
      const next = g + steps;
      if (next < 0 || next > 255) return null;
      edits.push({ pos: bitPos, value: next });
    }
    frames++;
    off += f.length;
  }
  if (!frames || !edits.length) return null;

  for (const e of edits) setBits(out, e.pos, 8, e.value);
  return out;
}
