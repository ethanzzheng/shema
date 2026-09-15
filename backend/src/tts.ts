/**
 * ElevenLabs Text-to-Speech (streaming HTTP).
 * Converts English sermon text to MP3 audio, returned as a Buffer.
 */

import { mp3Level, mp3ApplyGain } from './mp3-level';

// Uses native fetch (Node 18+)

const TTS_BASE = 'https://api.elevenlabs.io/v1/text-to-speech';

interface TTSOptions {
  apiKey: string;
  voiceId: string;
  modelId?: string;
  /** Speaking rate (ElevenLabs voice_settings.speed, ~0.7–1.2). Omit = model default. */
  speed?: number;
}

interface VoiceSettings {
  stability: number;
  similarity_boost: number;
  style?: number;
  use_speaker_boost?: boolean;
  speed?: number;
}

/** Parse an env float, falling back when unset or not a number. */
function envFloat(name: string, fallback: number): number {
  const v = parseFloat(process.env[name] ?? '');
  return Number.isFinite(v) ? v : fallback;
}

// Higher stability + zero style = steadier clip-to-clip loudness (each clip
// is delivered less "expressively", so volume stops swinging between
// sentences). Ear-tunable via env without code changes:
//   TTS_STABILITY (default 0.5)  — lower = more expressive, more variance
//   TTS_STYLE     (default 0)    — style exaggeration re-adds variance
const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  stability: envFloat('TTS_STABILITY', 0.5),
  similarity_boost: envFloat('TTS_SIMILARITY', 0.75),
  style: envFloat('TTS_STYLE', 0),
  // Speaker boost is a known source of clip-to-clip level variance, and one
  // clip in 231 came back at a whisper (peak -20.4 dB against a typical -0.6
  // to -5). Every clip is synthesised with identical settings, so that
  // variance is the vendor's, not ours — default it off and leave it tunable.
  use_speaker_boost: (process.env.TTS_SPEAKER_BOOST ?? '0') === '1',
};

/**
 * Clips whose text is at or below this are buffered and level-checked.
 *
 * Measured over two full services, holding the whole clip instead of
 * forwarding its first byte costs a median of 55ms (p90 ~180ms) — the audio
 * does not trickle in over its playing time. Against a ~1.9s end-to-end that
 * is ~3%, cheap enough to check everything rather than only short lines. The
 * ceiling is a guard against a pathological segment, not a filter: the longest
 * segment observed in a real service was 273 characters.
 */
const LEVEL_CHECK_MAX_CHARS = Number(process.env.TTS_LEVEL_CHECK_MAX_CHARS ?? 400);

/**
 * Mean global_gain below which a clip is raised, and the level aimed for.
 *
 * Deliberately conservative, and the ceiling below is the reason. Measured
 * across 411 clips of a real service, this catches the clips that are
 * inaudible rather than merely quiet.
 */
const MIN_MEAN_GAIN = Number(process.env.TTS_MIN_MEAN_GAIN ?? 147);
const TARGET_MEAN_GAIN = Number(process.env.TTS_TARGET_MEAN_GAIN ?? 155);

/**
 * Hard ceiling on the correction — and the honest limit of this whole approach.
 *
 * global_gain scales a granule, but says nothing about the clip's PEAK: the
 * loudest granule saturates at 210 in almost every clip and correlates only
 * 0.136 with measured peak amplitude, so the bitstream cannot tell us how much
 * headroom there is. Speech has a wide crest factor — a clip can average -23 dB
 * and still peak at -6 dB — so raising it to a normal AVERAGE clips the loud
 * syllables.
 *
 * Measured, raising everything below gain 152 toward the median pushed 21 of
 * 411 clips from real headroom to 0 dB — trading a quiet clip for a distorted
 * one, which is the worse defect. At this threshold and ceiling nothing clips:
 * the worst result across both services still had 2.5 dB of headroom.
 *
 * The cost of that safety is real: it lifts the inaudible clips (-40.9 dB ->
 * -31.9) and leaves the merely-quiet ones ("Amen." at -23 dB) alone, because
 * those are exactly the ones with the peaks. Fixing those too needs a genuine
 * peak measurement, which needs decoding, which needs ffmpeg in the image.
 */
const MAX_GAIN_STEPS = Number(process.env.TTS_MAX_GAIN_STEPS ?? 6);

export class ElevenLabsTTS {
  private apiKey: string;
  private voiceId: string;
  private modelId: string;
  private voiceSettings: VoiceSettings;

  constructor(opts: TTSOptions) {
    this.apiKey = opts.apiKey;
    this.voiceId = opts.voiceId;
    this.modelId = opts.modelId ?? process.env.TTS_MODEL ?? 'eleven_flash_v2_5';
    this.voiceSettings = {
      ...DEFAULT_VOICE_SETTINGS,
      ...(opts.speed && opts.speed !== 1 ? { speed: opts.speed } : {}),
    };
  }

  // The non-streaming synthesise() lived here and had no callers. It was a
  // byte-identical copy of the request below, which is how a previous_text
  // edit silently landed in the dead copy — removed rather than kept in sync.

  async synthesiseStream(
    text: string,
    onChunk: (chunk: Buffer) => void,
    timeoutMs = 8000,
    previousText?: string,
  ): Promise<void> {
    const url = `${TTS_BASE}/${this.voiceId}/stream?output_format=mp3_44100_128`;

    // previous_text gives ElevenLabs the preceding sentence so it can match
    // prosody and level across the clip boundary. Clips were being synthesised
    // in total prosodic isolation, which is exactly the discontinuity this
    // parameter exists to smooth, and one clip in 231 came back at a whisper.
    // Costs a larger request body and no latency — the previous sentence is
    // already known when we enqueue.
    const body = JSON.stringify({
      text,
      model_id: this.modelId,
      voice_settings: this.voiceSettings,
      ...(previousText ? { previous_text: previousText.slice(-400) } : {}),
    });

    const controller = new AbortController();
    let watchdog: NodeJS.Timeout | null = null;
    const arm = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => controller.abort(), timeoutMs);
    };
    arm();

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': this.apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`ElevenLabs TTS HTTP ${response.status}: ${errText}`);
      }
      if (!response.body) throw new Error('ElevenLabs TTS returned no body');

      // response.body is a web ReadableStream in Node 18+; read incrementally.
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        arm();
        if (done) break;
        if (value && value.length) onChunk(Buffer.from(value));
      }
    } finally {
      if (watchdog) clearTimeout(watchdog);
    }
  }

  /**
   * Synthesise, then check the clip actually came back at a usable level and
   * raise it if not.
   *
   * ElevenLabs returns some clips far under the level of their neighbours.
   * Across a 46-minute service 4 clips in 411 landed more than 6 dB below the
   * median and the worst was -40.9 dB — inaudible, not merely quiet.
   *
   * The first version of this re-synthesised the clip, on the assumption the
   * quietness was random. It is not: a second service showed "Amen." coming
   * back quiet on the retry as well, so retrying only ever kept the better of
   * two bad clips. Raising the clip directly is deterministic, costs no extra
   * API call, and is lossless — global_gain is the exponent the decoder
   * applies when it requantises, so adding to it scales the output without
   * touching the coded spectrum.
   *
   * Verified on all 411 clips of a recorded service: every one re-decoded with
   * no errors, no duration drift, and a measured rise of +5.4 dB for 4 steps.
   */
  async synthesiseStreamLevelled(
    text: string,
    onChunk: (chunk: Buffer) => void,
    timeoutMs = 8000,
    previousText?: string,
    onRaise?: (info: { meanGain: number; steps: number; text: string }) => void,
  ): Promise<void> {
    if (text.length > LEVEL_CHECK_MAX_CHARS) {
      return this.synthesiseStream(text, onChunk, timeoutMs, previousText);
    }

    const parts: Buffer[] = [];
    await this.synthesiseStream(text, (c) => parts.push(c), timeoutMs, previousText);
    let clip = Buffer.concat(parts);
    if (!clip.length) return;

    const level = mp3Level(clip);
    // A null level means the buffer did not parse as MP3. Leave it alone
    // rather than act on a guess — the clip is very likely fine.
    if (level && level.meanGain < MIN_MEAN_GAIN) {
      const steps = Math.min(MAX_GAIN_STEPS, Math.round(TARGET_MEAN_GAIN - level.meanGain));
      if (steps > 0) {
        const raised = mp3ApplyGain(clip, steps);
        // mp3ApplyGain returns null rather than a partial rewrite if any
        // granule would saturate, so a failure here is safe to ignore.
        if (raised) {
          // Copy through Buffer.from: mp3ApplyGain allocates its own buffer and
          // the two differ only in the types package's ArrayBuffer variance.
          clip = Buffer.from(raised);
          onRaise?.({ meanGain: level.meanGain, steps, text });
        }
      }
    }

    if (clip.length) onChunk(clip);
  }
}
