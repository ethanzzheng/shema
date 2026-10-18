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
 * The Mandarin sample does the same with 腓立比书 4:6, the verse quoted in
 * full, and 小组, a church term.
 *
 *   npx tsx scripts/make-demo-sample.ts          (Korean → sample-sermon.mp3)
 *   npx tsx scripts/make-demo-sample.ts --zh     (Mandarin → sample-sermon-zh.mp3)
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

const SCRIPT_KO = [
  '사랑하는 성도 여러분, 오늘 함께 나눌 말씀은 베드로전서 2장 9절입니다.',
  '여러분은 택하신 족속이요, 왕 같은 제사장이요, 거룩한 나라입니다.',
  '이것은 우리가 잘나서가 아니라, 오직 하나님의 은혜 때문입니다.',
  '이번 주 목장 모임에서도 이 말씀을 함께 나누시기 바랍니다.',
  '한 주 동안 이 은혜를 기억하며 살아가는 여러분 되시기를 축복합니다.',
].join(' ');

const SCRIPT_ZH = [
  '弟兄姊妹，今天我们一起来看腓立比书第四章第六节。',
  '经文说：应当一无挂虑，只要凡事借着祷告、祈求和感谢，将你们所要的告诉神。',
  '这不是说我们没有难处，而是说我们可以把难处交给神。',
  '这个礼拜的小组聚会，也请大家一起分享这段经文。',
  '愿神的平安，保守你们的心怀意念。',
].join('');

/**
 * No Mandarin voice is configured for the live pipeline (Mandarin is only ever
 * the source), so the sample uses a premade voice ElevenLabs verifies for
 * Chinese: Brian, a deep, steady male voice. Of the two tried (Brian and
 * Bill) it read the verse more cleanly and ran 27s, the same as the Korean
 * clip. ELEVENLABS_VOICE_ID_ZH_SAMPLE overrides.
 */
const ZH_SAMPLE_VOICE = 'nPczCjzI2devNBz1zQrb';

async function main(): Promise<void> {
  const zh = process.argv.includes('--zh');
  const apiKey = process.env.ELEVENLABS_API_KEY;
  // A voice for the SOURCE language, since the sample is what a pastor would speak.
  const voiceId = zh ? process.env.ELEVENLABS_VOICE_ID_ZH_SAMPLE || ZH_SAMPLE_VOICE : process.env.ELEVENLABS_VOICE_ID_KO;
  if (!apiKey || !voiceId) {
    console.error('Need ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID_KO in backend/.env');
    process.exit(1);
  }
  const script = zh ? SCRIPT_ZH : SCRIPT_KO;

  console.log(`Script (${script.length} chars):\n  ${script}\n`);

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: script,
        // Flash reads Mandarin with audible slips; the sample is generated once,
        // so it gets the slower, cleaner multilingual model.
        model_id: zh ? 'eleven_multilingual_v2' : process.env.TTS_MODEL ?? 'eleven_flash_v2_5',
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

  const out = path.resolve(__dirname, `../../frontend/public/demo/${zh ? 'sample-sermon-zh' : 'sample-sermon'}.mp3`);
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  if (zh) {
    // The demo streams the clip and then simply stops, so recognition never
    // hears the pause that would finalize the last sentence, and 愿神的平安…
    // was never translated. 2.5s of silence at the end supplies it.
    const raw = `${out}.raw.mp3`;
    fs.renameSync(out, raw);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', raw, '-af', 'apad=pad_dur=2.5', '-c:a', 'libmp3lame', '-b:a', '128k', out]);
    fs.unlinkSync(raw);
  }
  const kb = (fs.statSync(out).size / 1024).toFixed(0);
  console.log(`Wrote ${out} (${kb} KB)`);
  console.log('\nRe-run this after changing the script. Costs one short TTS call.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
