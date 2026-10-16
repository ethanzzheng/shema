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

export type Direction = 'ko-en' | 'en-ko' | 'zh-en' | 'yue-en';

export interface DirectionConfig {
  /** Deepgram streaming `language` parameter for the INPUT speech. */
  sttLanguage: string;
  /** Deepgram model. Mandarin may need a different model than Korean. */
  sttModel: string;
  /**
   * Deepgram smart_format. Off for Mandarin: it mangles Chinese numerals into
   * mixed forms ("罗马书8章二十8节"), and punctuate alone still punctuates.
   */
  sttSmartFormat: boolean;
  /**
   * Env vars that override sttModel / sttLanguage for this direction, so a
   * deployment can switch (e.g. zh-TW for a Taiwanese congregation) without a
   * code change. Never auto-detect: zh-HK is CANTONESE and turns Mandarin
   * into nonsense.
   */
  sttModelEnvVar?: string;
  sttLanguageEnvVar?: string;
  /** ISO-ish code of the spoken (input) language, for transcripts. */
  sourceLang: 'ko' | 'en' | 'zh';
  /** Output language — what listeners hear, and what glossary renderings key on. */
  targetLang: 'en' | 'ko';
  /** Human names used inside translator prompts ("Translate ONLY this new Korean segment"). */
  sourceLabel: string;
  targetLabel: string;
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
  translator: Direction;
  /**
   * Translation model for this direction when it should differ from the
   * global TRANSLATION_MODEL; its env var wins over it.
   */
  translationModel?: string;
  translationModelEnvVar?: string;
  /** Which sentence-assembly grammar the chunker uses. */
  chunker: 'korean' | 'english' | 'chinese';
  /**
   * Ask a fast model whether the buffer ends at a complete thought (see
   * boundary-oracle.ts). Chinese has no grammatical sentence ending for the
   * chunker to read, so this stands in for one. BOUNDARY_ORACLE=0 turns it off.
   */
  boundaryOracle?: boolean;
  /** Model for that check; BOUNDARY_ORACLE_MODEL wins. Default Haiku 5.5. */
  oracleModel?: string;
  /** Default ElevenLabs speaking rate for this direction; TTS_SPEED_<X> wins. */
  ttsSpeed?: number;
  ttsSpeedEnvVar?: string;
  /** False = the pipeline refuses to start a broadcast in this direction. */
  implemented: boolean;
}

export const DIRECTION_CONFIGS: Record<Direction, DirectionConfig> = {
  'ko-en': {
    sttLanguage: 'ko',
    sttModel: 'nova-3',
    sttSmartFormat: true,
    sourceLang: 'ko',
    targetLang: 'en',
    sourceLabel: 'Korean',
    targetLabel: 'English',
    ttsVoiceIdEnvVars: ['ELEVENLABS_VOICE_ID_EN', 'ELEVENLABS_VOICE_ID'],
    ttsModelEnvVars: ['TTS_MODEL'],
    ttsModelId: 'eleven_flash_v2_5',
    translator: 'ko-en',
    chunker: 'korean',
    implemented: true,
  },
  'en-ko': {
    sttLanguage: 'en',
    sttModel: 'nova-3',
    sttSmartFormat: true,
    sourceLang: 'en',
    targetLang: 'ko',
    sourceLabel: 'English',
    targetLabel: 'Korean',
    // No fallback to the English voice: an unconfigured Korean voice should
    // fail loudly, not read Korean in the English voice.
    ttsVoiceIdEnvVars: ['ELEVENLABS_VOICE_ID_KO'],
    // TTS_MODEL_KO only — deliberately independent of the English TTS_MODEL
    // so eleven_multilingual_v2 can be A/B tested without touching ko-en.
    ttsModelEnvVars: ['TTS_MODEL_KO'],
    ttsModelId: 'eleven_flash_v2_5',
    translator: 'en-ko',
    chunker: 'english',
    implemented: true,
  },
  'zh-en': {
    // nova-3 over nova-2, measured on two ~4-minute synthetic Mandarin sermons:
    // character error was a wash (3.3% vs 5.5% on one voice, 15.9% vs 12.8% on
    // the other), but nova-3 emitted 2-3x more sentence punctuation, which is
    // what the Mandarin chunker splits on, and only nova-3 takes keyterms. Its
    // cost is occasional dropped words — watch for that in real services.
    sttLanguage: 'zh-CN',
    sttModel: 'nova-3',
    sttSmartFormat: false,
    sttModelEnvVar: 'STT_MODEL_ZH',
    sttLanguageEnvVar: 'STT_LANGUAGE_ZH',
    sourceLang: 'zh',
    targetLang: 'en',
    sourceLabel: 'Mandarin Chinese',
    targetLabel: 'English',
    // Same English voice and model as ko-en: the OUTPUT is English either way.
    ttsVoiceIdEnvVars: ['ELEVENLABS_VOICE_ID_EN', 'ELEVENLABS_VOICE_ID'],
    ttsModelEnvVars: ['TTS_MODEL'],
    ttsModelId: 'eleven_flash_v2_5',
    translator: 'zh-en',
    // Replayed on a real service, Sonnet 5.5 had half the flagged lines of
    // Sonnet 5 (3-4 vs 7-9 of 240) for ~0.1s more median translation time.
    translationModel: 'claude-sonnet-5-5',
    translationModelEnvVar: 'TRANSLATION_MODEL_ZH',
    chunker: 'chinese',
    boundaryOracle: true,
    ttsSpeedEnvVar: 'TTS_SPEED_ZH',
    implemented: true,
  },
  // Cantonese. Deepgram nova-3 zh-HK returns Traditional characters, mostly
  // in written-Chinese form with colloquial words left in (喺, 係, 啲, 嘅).
  // Detection folds it to Simplified (zh-script.ts), so the Mandarin rules and
  // Bible tables apply, plus Cantonese particles and openers on top.
  'yue-en': {
    sttLanguage: 'zh-HK',
    sttModel: 'nova-3',
    sttSmartFormat: false,
    sttModelEnvVar: 'STT_MODEL_YUE',
    sttLanguageEnvVar: 'STT_LANGUAGE_YUE',
    sourceLang: 'zh',
    targetLang: 'en',
    sourceLabel: 'Cantonese',
    targetLabel: 'English',
    ttsVoiceIdEnvVars: ['ELEVENLABS_VOICE_ID_EN', 'ELEVENLABS_VOICE_ID'],
    ttsModelEnvVars: ['TTS_MODEL'],
    ttsModelId: 'eleven_flash_v2_5',
    translator: 'yue-en',
    translationModel: 'claude-sonnet-5-5',
    translationModelEnvVar: 'TRANSLATION_MODEL_YUE',
    chunker: 'chinese',
    boundaryOracle: true,
    // Haiku cut garbled Cantonese mid-thought (45 broken cuts on four
    // sermons against 31 before); Sonnet 5.5 kept it at 31 and still took a
    // third off the delay. Mandarin stays on Haiku: none of its cuts broke.
    oracleModel: 'claude-sonnet-5-5',
    ttsSpeedEnvVar: 'TTS_SPEED_YUE',
    implemented: true,
  },
};

/** Mandarin or Cantonese: the directions that share the Chinese pipeline. */
export function isChinese(direction: Direction): boolean {
  return direction === 'zh-en' || direction === 'yue-en';
}

/** Parse a client-supplied direction; anything unrecognized is ko-en. */
export function normalizeDirection(raw: unknown): Direction {
  return raw === 'en-ko' || raw === 'zh-en' || raw === 'yue-en' ? raw : 'ko-en';
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

/** Deepgram model + language for this direction, honouring per-direction env overrides. */
export function resolveStt(
  direction: Direction,
  env: NodeJS.ProcessEnv = process.env,
): { model: string; language: string; smartFormat: boolean } {
  const cfg = DIRECTION_CONFIGS[direction];
  return {
    model: (cfg.sttModelEnvVar && env[cfg.sttModelEnvVar]) || cfg.sttModel,
    language: (cfg.sttLanguageEnvVar && env[cfg.sttLanguageEnvVar]) || cfg.sttLanguage,
    smartFormat: cfg.sttSmartFormat,
  };
}

/** The translation model for this direction: per-direction env, its default, then the global one. */
export function resolveTranslationModel(direction: Direction, env: NodeJS.ProcessEnv = process.env): string {
  const cfg = DIRECTION_CONFIGS[direction];
  return (
    (cfg.translationModelEnvVar && env[cfg.translationModelEnvVar]) ||
    cfg.translationModel ||
    env.TRANSLATION_MODEL ||
    'claude-sonnet-5'
  );
}
