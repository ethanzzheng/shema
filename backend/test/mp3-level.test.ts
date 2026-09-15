import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { mp3Level, mp3ApplyGain } from '../src/mp3-level';

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

test('mp3ApplyGain refuses anything it cannot parse', () => {
  // Writing bytes into audio is the one operation here that could damage a
  // real clip, so every uncertain case must return null and leave the caller
  // sending the original.
  assert.equal(mp3ApplyGain(Buffer.from('not audio'), 4), null);
  assert.equal(mp3ApplyGain(Buffer.alloc(0), 4), null);
  assert.equal(mp3ApplyGain(Buffer.alloc(4096), 4), null);
});

test('mp3ApplyGain is a no-op for a zero or nonsense step', () => {
  assert.equal(mp3ApplyGain(Buffer.alloc(64), 0), null);
  assert.equal(mp3ApplyGain(Buffer.alloc(64), NaN), null);
});

test('mp3ApplyGain raises the level and never mutates its input', { skip: !haveClips }, () => {
  const src = fs.readFileSync(path.join(CLIPS, 'seq-0021.mp3'));
  const before = Buffer.from(src);
  const raised = mp3ApplyGain(src, 4);
  assert.ok(raised, 'a real clip should rewrite');
  assert.ok(src.equals(before), 'the input buffer must not be mutated');
  assert.equal(raised!.length, src.length, 'rewriting must not change the byte length');

  const a = mp3Level(src)!, b = mp3Level(raised!)!;
  assert.ok(
    Math.abs(b.meanGain - (a.meanGain + 4)) < 0.001,
    `expected +4 steps, got ${a.meanGain} -> ${b.meanGain}`,
  );
  assert.equal(b.frames, a.frames, 'frame count must be unchanged');
});

test('mp3ApplyGain returns null rather than a partial rewrite when it would saturate', { skip: !haveClips }, () => {
  // A clip half-raised is worse than one left alone: the level would jump
  // mid-sentence. An impossible boost must change nothing at all.
  const src = fs.readFileSync(path.join(CLIPS, 'seq-0021.mp3'));
  assert.equal(mp3ApplyGain(src, 10_000), null);
  assert.equal(mp3ApplyGain(src, -10_000), null);
});
