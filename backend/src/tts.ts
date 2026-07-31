/**
 * ElevenLabs Text-to-Speech (streaming HTTP).
 * Converts English sermon text to MP3 audio, returned as a Buffer.
 */

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
  similarity_boost: 0.75,
  style: envFloat('TTS_STYLE', 0),
  use_speaker_boost: true,
};

export class ElevenLabsTTS {
  private apiKey: string;
  private voiceId: string;
  private modelId: string;
  private voiceSettings: VoiceSettings;

  constructor(opts: TTSOptions) {
    this.apiKey = opts.apiKey;
    this.voiceId = opts.voiceId;
    this.modelId = opts.modelId ?? process.env.TTS_MODEL ?? 'eleven_turbo_v2_5';
    this.voiceSettings = {
      ...DEFAULT_VOICE_SETTINGS,
      ...(opts.speed && opts.speed !== 1 ? { speed: opts.speed } : {}),
    };
  }

  /**
   * Synthesise text and return the raw MP3 Buffer.
   * Throws on HTTP error.
   */
  async synthesise(text: string): Promise<Buffer> {
    const url = `${TTS_BASE}/${this.voiceId}/stream?output_format=mp3_44100_128`;

    const body = JSON.stringify({
      text,
      model_id: this.modelId,
      voice_settings: this.voiceSettings,
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': this.apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`ElevenLabs TTS HTTP ${response.status}: ${errText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * Synthesise text and forward MP3 chunks to `onChunk` AS THEY ARRIVE from
   * ElevenLabs, instead of buffering the whole clip first. This is what lets
   * the listener start playing audio before synthesis finishes.
   * Resolves once the full stream has been consumed. Throws on HTTP error.
   *
   * An inactivity watchdog aborts the request if no data arrives for
   * `timeoutMs` — without it, one hung request silently stalled every clip
   * queued behind it (the listener heard a long gap while translated text
   * kept appearing).
   */
  async synthesiseStream(
    text: string,
    onChunk: (chunk: Buffer) => void,
    timeoutMs = 8000,
  ): Promise<void> {
    const url = `${TTS_BASE}/${this.voiceId}/stream?output_format=mp3_44100_128`;

    const body = JSON.stringify({
      text,
      model_id: this.modelId,
      voice_settings: this.voiceSettings,
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
}
