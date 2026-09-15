/**
 * ElevenLabs Text-to-Speech (streaming HTTP).
 * Converts English sermon text to MP3 audio, returned as a Buffer.
 */

import { mp3Level } from './mp3-level';

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
 * Lines at or below this many characters are held and checked. Chosen from the
 * service data: every clip that came back too quiet was short, and 50-60
 * characters covers all of them while leaving the long clips streaming.
 */
const SHORT_TEXT_MAX = Number(process.env.TTS_LEVEL_CHECK_MAX_CHARS ?? 60);

/**
 * Mean global_gain below which a clip is treated as under-driven. Validated
 * against all 411 clips of a real service: this threshold flagged 6 of them
 * and caught all 4 that a listener would actually notice, with 2 false alarms
 * — and a false alarm only costs one extra synthesis of a very short line.
 */
const MIN_MEAN_GAIN = Number(process.env.TTS_MIN_MEAN_GAIN ?? 150);

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
   * Synthesise, and for SHORT lines check the clip actually came back at a
   * usable level before releasing it.
   *
   * ElevenLabs occasionally returns a short utterance far under the level of
   * its neighbours. Across a 46-minute service, 4 clips in 411 landed more
   * than 6 dB below the median and the worst was -40.9 dB — inaudible, not
   * merely quiet. Every one was short: the quiet clips' median duration was
   * 1.06s against 4.08s for the rest. "Amen." twice.
   *
   * Buffering is what makes this affordable. The clip does not trickle in over
   * its playing time — measured over that service, time-to-first-byte was
   * 275ms and full synthesis 345ms, a difference of about 70ms. So holding a
   * short clip to inspect it costs tens of milliseconds, not seconds.
   *
   * Only lines under SHORT_TEXT_MAX are held; longer ones stream through
   * untouched, because the defect does not occur there and they are the ones
   * where buffering would actually cost something.
   */
  async synthesiseStreamLevelled(
    text: string,
    onChunk: (chunk: Buffer) => void,
    timeoutMs = 8000,
    previousText?: string,
    onRetry?: (info: { meanGain: number; text: string }) => void,
  ): Promise<void> {
    if (text.length > SHORT_TEXT_MAX) {
      return this.synthesiseStream(text, onChunk, timeoutMs, previousText);
    }

    const collect = async (): Promise<Buffer> => {
      const parts: Buffer[] = [];
      await this.synthesiseStream(text, (c) => parts.push(c), timeoutMs, previousText);
      return Buffer.concat(parts);
    };

    let clip = await collect();
    const level = mp3Level(clip);

    // A null level means the buffer did not parse as MP3. Leave it alone
    // rather than act on a guess — the clip is very likely fine.
    if (level && level.meanGain < MIN_MEAN_GAIN) {
      onRetry?.({ meanGain: level.meanGain, text });
      try {
        const second = await collect();
        const secondLevel = mp3Level(second);
        // Keep whichever came back louder; a retry can be quiet too.
        if (second.length && (!secondLevel || secondLevel.meanGain > level.meanGain)) {
          clip = second;
        }
      } catch {
        // Keep the first clip: quiet audio beats no audio.
      }
    }

    if (clip.length) onChunk(clip);
  }
}
