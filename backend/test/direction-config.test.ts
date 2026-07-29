/**
 * Direction seam: ko-en must resolve to exactly the pre-refactor pipeline
 * config (same STT language, same voice env resolution, same TTS model), and
 * en-ko must be declared-but-refused until it's implemented.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  DIRECTION_CONFIGS,
  normalizeDirection,
  resolveTtsModelId,
  resolveTtsVoiceId,
} from '../src/direction-config';
import { Session } from '../src/session';

describe('normalizeDirection', () => {
  test('anything but en-ko is ko-en (the legacy default)', () => {
    assert.equal(normalizeDirection(undefined), 'ko-en');
    assert.equal(normalizeDirection(null), 'ko-en');
    assert.equal(normalizeDirection('ko-en'), 'ko-en');
    assert.equal(normalizeDirection('garbage'), 'ko-en');
    assert.equal(normalizeDirection('en-ko'), 'en-ko');
  });
});

describe('ko-en config (must match the pre-refactor hardcoded pipeline)', () => {
  const cfg = DIRECTION_CONFIGS['ko-en'];

  test('same STT language, TTS model, translator, and chunker as before', () => {
    assert.equal(cfg.sttLanguage, 'ko');
    assert.equal(cfg.ttsModelId, 'eleven_turbo_v2_5');
    assert.equal(cfg.translator, 'ko-en');
    assert.equal(cfg.chunker, 'korean');
    assert.equal(cfg.implemented, true);
  });

  test('voice: legacy ELEVENLABS_VOICE_ID still works; _EN wins when set', () => {
    assert.equal(resolveTtsVoiceId('ko-en', { ELEVENLABS_VOICE_ID: 'legacy' }), 'legacy');
    assert.equal(
      resolveTtsVoiceId('ko-en', { ELEVENLABS_VOICE_ID: 'legacy', ELEVENLABS_VOICE_ID_EN: 'en' }),
      'en',
    );
    assert.equal(resolveTtsVoiceId('ko-en', {}), null);
  });

  test('TTS_MODEL env still overrides the model, as before — and only ko-en', () => {
    assert.equal(resolveTtsModelId('ko-en', {}), 'eleven_turbo_v2_5');
    assert.equal(resolveTtsModelId('ko-en', { TTS_MODEL: 'eleven_flash_v2_5' }), 'eleven_flash_v2_5');
    assert.equal(resolveTtsModelId('ko-en', { TTS_MODEL_KO: 'eleven_multilingual_v2' }), 'eleven_turbo_v2_5');
  });
});

describe('en-ko config (live)', () => {
  const cfg = DIRECTION_CONFIGS['en-ko'];

  test('implemented, with English STT and the en-ko translator/chunker', () => {
    assert.equal(cfg.implemented, true);
    assert.equal(cfg.sttLanguage, 'en');
    assert.equal(cfg.translator, 'en-ko');
    assert.equal(cfg.chunker, 'english');
  });

  test('Korean voice never falls back to the English voice', () => {
    assert.equal(resolveTtsVoiceId('en-ko', { ELEVENLABS_VOICE_ID: 'english' }), null);
    assert.equal(
      resolveTtsVoiceId('en-ko', { ELEVENLABS_VOICE_ID: 'english', ELEVENLABS_VOICE_ID_KO: 'ko' }),
      'ko',
    );
  });

  test('Korean TTS model: TTS_MODEL_KO overrides, independent of TTS_MODEL', () => {
    assert.equal(resolveTtsModelId('en-ko', {}), 'eleven_turbo_v2_5');
    assert.equal(
      resolveTtsModelId('en-ko', { TTS_MODEL_KO: 'eleven_multilingual_v2' }),
      'eleven_multilingual_v2',
    );
    // The English A/B knob must not leak into the Korean voice.
    assert.equal(resolveTtsModelId('en-ko', { TTS_MODEL: 'eleven_flash_v2_5' }), 'eleven_turbo_v2_5');
  });
});

describe('Session direction', () => {
  test('defaults to ko-en and resets back to it', () => {
    const s = new Session('x');
    assert.equal(s.direction, 'ko-en');
    s.direction = 'en-ko';
    s.reset();
    assert.equal(s.direction, 'ko-en');
  });
});
