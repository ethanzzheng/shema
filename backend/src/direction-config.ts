/**
 * Per-direction pipeline configuration — the single seam every stage reads.
 *
 * A Direction names the translation direction ('ko-en' = Korean speech in,
 * English audio out). Each config declares the direction-coupled knobs: the
 * STT language, which ElevenLabs voice/model speaks the output, and which
 * translator prompt / chunker grammar the pipeline uses. Implementing a new
 * direction means filling in its config + implementations here — the
 * transport (rooms, WS protocol, ordering, TTS pipelining) is
 * direction-agnostic and never changes.
 *
 * Both directions are live: ko-en is the original pipeline; en-ko runs the
 * English chunker/scripture detector and the Korean sermon-register
 * translator, and requires ELEVENLABS_VOICE_ID_KO to be configured.
 */

export type Direction = 'ko-en' | 'en-ko';

export interface DirectionConfig {
  /** Deepgram streaming `language` parameter for the INPUT speech. */
  sttLanguage: string;
  /**
   * Env vars naming the ElevenLabs voice for the OUTPUT language, tried in
   * order. ko-en keeps the legacy ELEVENLABS_VOICE_ID as a fallback so
   * existing deployments keep working unchanged.
   */
  ttsVoiceIdEnvVars: string[];
  /** Env vars that override the TTS model for this direction, tried in order. */
  ttsModelEnvVars: string[];
  /** Default ElevenLabs TTS model when no env override is set. */
  ttsModelId: string;
  /** Which translator prompt this direction uses. */
  translator: 'ko-en' | 'en-ko';
  /** Which sentence-assembly grammar the chunker uses. */
  chunker: 'korean' | 'english';
  /** False = the pipeline refuses to start a broadcast in this direction. */
  implemented: boolean;
}

export const DIRECTION_CONFIGS: Record<Direction, DirectionConfig> = {
  'ko-en': {
    sttLanguage: 'ko',
    ttsVoiceIdEnvVars: ['ELEVENLABS_VOICE_ID_EN', 'ELEVENLABS_VOICE_ID'],
    ttsModelEnvVars: ['TTS_MODEL'],
    ttsModelId: 'eleven_turbo_v2_5',
    translator: 'ko-en',
    chunker: 'korean',
    implemented: true,
  },
  'en-ko': {
    sttLanguage: 'en',
    // No fallback to the English voice: an unconfigured Korean voice should
    // fail loudly, not read Korean in the English voice.
    ttsVoiceIdEnvVars: ['ELEVENLABS_VOICE_ID_KO'],
    // TTS_MODEL_KO only — deliberately independent of the English TTS_MODEL
    // so eleven_multilingual_v2 can be A/B tested without touching ko-en.
    ttsModelEnvVars: ['TTS_MODEL_KO'],
    ttsModelId: 'eleven_turbo_v2_5',
    translator: 'en-ko',
    chunker: 'english',
    implemented: true,
  },
};

/** Parse a client-supplied direction; anything unrecognized is ko-en. */
export function normalizeDirection(raw: unknown): Direction {
  return raw === 'en-ko' ? 'en-ko' : 'ko-en';
}

export function getDirectionConfig(direction: Direction): DirectionConfig {
  return DIRECTION_CONFIGS[direction];
}

/** The ElevenLabs voice for this direction's output, or null if unconfigured. */
export function resolveTtsVoiceId(
  direction: Direction,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  for (const name of DIRECTION_CONFIGS[direction].ttsVoiceIdEnvVars) {
    const v = env[name];
    if (v) return v;
  }
  return null;
}

/** The ElevenLabs model for this direction (per-direction env var wins). */
export function resolveTtsModelId(
  direction: Direction,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const cfg = DIRECTION_CONFIGS[direction];
  for (const name of cfg.ttsModelEnvVars) {
    const v = env[name];
    if (v) return v;
  }
  return cfg.ttsModelId;
}
