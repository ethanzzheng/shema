import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { mp3Level } from '../src/mp3-level';

test('mp3Level returns null for anything that is not MP3', () => {
  // Fail-safe matters more than coverage here: a null makes the caller leave
  // the clip alone, so a parsing miss can never degrade real audio.
  assert.equal(mp3Level(Buffer.alloc(0)), null);
  assert.equal(mp3Level(Buffer.from('not audio at all, just text')), null);
  assert.equal(mp3Level(Buffer.alloc(4096)), null);
});

test('mp3Level survives a truncated frame without throwing', () => {
  // Clips are buffered from a network stream; a half-frame tail is normal.
  const almost = Buffer.from([0xff, 0xfb, 0x90, 0x44, 0x00, 0x00]);
  assert.doesNotThrow(() => mp3Level(almost));
});

/**
 * Scored against real clips from a recorded service when they are present.
 * The run directory is gitignored, so this is a local-only check rather than
 * something CI can assert — it is the evidence that the threshold means
 * anything, so it is worth keeping runnable.
 */
const CLIPS = path.join(__dirname, '../evals/runs/service2/clips');
const haveClips = fs.existsSync(CLIPS);

test('under-driven clips score below the threshold and normal ones above', { skip: !haveClips }, () => {
  const gain = (f: string) => {
    const lvl = mp3Level(fs.readFileSync(path.join(CLIPS, f)));
    assert.ok(lvl, `${f} should parse as MP3`);
    return lvl!.meanGain;
  };
  // Measured with ffmpeg volumedetect: -40.9, -30.5, -23.6, -22.8 dB.
  for (const f of ['seq-0151.mp3', 'seq-0032.mp3', 'seq-0404.mp3', 'seq-0021.mp3']) {
    assert.ok(gain(f) < 150, `${f} is audibly quiet and should score under 150, got ${gain(f)}`);
  }
  // Measured at -10.9 and -12.3 dB — comfortably normal.
  for (const f of ['seq-0215.mp3', 'seq-0061.mp3']) {
    assert.ok(gain(f) >= 150, `${f} is a normal clip and should score over 150, got ${gain(f)}`);
  }
});
