/**
 * Generate the demo's sample audio.
 *
 * Deliberately a written script read by our own ElevenLabs voice rather than a
 * recording of a real service: strangers arriving from a cold email should not
 * be listening to a real congregation, and a scripted read is also clean, free
 * of background noise, and says exactly what we want it to.
 *
 * The passage is chosen to exercise the hard parts of the pipeline rather than
 * to be easy: a scripture citation to anchor, the quoted verse itself, and
 * 목장 — a church term that only comes out right because it is in the glossary.
 *
 *   npx tsx scripts/make-demo-sample.ts
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';

const SCRIPT_KO = [
  '사랑하는 성도 여러분, 오늘 함께 나눌 말씀은 베드로전서 2장 9절입니다.',
  '여러분은 택하신 족속이요, 왕 같은 제사장이요, 거룩한 나라입니다.',
  '이것은 우리가 잘나서가 아니라, 오직 하나님의 은혜 때문입니다.',
  '이번 주 목장 모임에서도 이 말씀을 함께 나누시기 바랍니다.',
  '한 주 동안 이 은혜를 기억하며 살아가는 여러분 되시기를 축복합니다.',
].join(' ');

async function main(): Promise<void> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  // The Korean voice, since the sample is the SOURCE audio a pastor would speak.
  const voiceId = process.env.ELEVENLABS_VOICE_ID_KO;
  if (!apiKey || !voiceId) {
    console.error('Need ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID_KO in backend/.env');
    process.exit(1);
  }

  console.log(`Script (${SCRIPT_KO.length} chars):\n  ${SCRIPT_KO}\n`);

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: SCRIPT_KO,
        model_id: process.env.TTS_MODEL ?? 'eleven_flash_v2_5',
        // Slightly slower and steadier than a live sermon: this is the first
        // thing a stranger hears, and clarity matters more than character.
        voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 0.95 },
      }),
    },
  );
  if (!res.ok) {
    console.error(`ElevenLabs returned ${res.status}: ${await res.text()}`);
    process.exit(1);
  }

  const out = path.resolve(__dirname, '../../frontend/public/demo/sample-sermon.mp3');
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  const kb = (fs.statSync(out).size / 1024).toFixed(0);
  console.log(`Wrote ${out} (${kb} KB)`);
  console.log('\nRe-run this after changing SCRIPT_KO. Costs one short TTS call.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
