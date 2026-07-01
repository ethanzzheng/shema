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
}

interface VoiceSettings {
  stability: number;
  similarity_boost: number;
  style?: number;
  use_speaker_boost?: boolean;
}

const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  stability: 0.3,
  similarity_boost: 0.75,
  style: 0.1,
  use_speaker_boost: true,
};

export class ElevenLabsTTS {
  private apiKey: string;
  private voiceId: string;
  private modelId: string;

  constructor(opts: TTSOptions) {
    this.apiKey = opts.apiKey;
    this.voiceId = opts.voiceId;
    this.modelId = opts.modelId ?? 'eleven_turbo_v2_5';
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
      voice_settings: DEFAULT_VOICE_SETTINGS,
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
}
