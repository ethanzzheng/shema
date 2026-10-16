# Mandarin and Cantonese → English: tuning plan

A living plan for making Chinese → English as good as Korean → English. It is
driven by measurement, improved one change at a time and re-measured after each.
Korean → English is not touched: every change is gated to the Chinese
directions, and the deployed-vs-local equivalence check must pass after each one.

## Where we start (15 October 2026, real audio, 10-minute slices)

| | Delay p50 | Delay p95 | Backlog trend | Clip p50 | Broken cuts / 10 min | Flow (1-5) | Lines flagged |
|---|---|---|---|---|---|---|---|
| Korean → English (reference) | 6.3s | 14.7s | flat | 4.6s | 0 | 4.56 | 3% |
| Mandarin, real service | 10.1s | 20.5s | flat* | 8.8s | 6 | 4.00 | 7% |
| Cantonese, sermon 1 (subtitled) | 23.8s | 33.2s | growing | 10.2s | 5 | 3.83 | 7% |
| Cantonese, sermon 2 (subtitled) | 9.0s | 19.9s | flat | 8.1s | 10 | 4.00 | 7% |
| Cantonese, sanctuary recording | 9.5s | 21.2s | flat | 9.4s | 20 | 3.00 | 6% |
| Cantonese, code-switching service | 31.5s | 43.3s | growing | 11.9s | 8 | 3.83 | 4% |

\*An earlier run of the same Mandarin slice grew to 15s of backlog. Runs vary,
so every claim needs at least two runs.

**Diagnosis:**

- **Translation accuracy is not the bottleneck.** Lines flagged run 4–7%, and
  most of those trace back to speech recognition or to a bad cut.
- **Chunking is.** Chinese speech recognition emits few sentence-ending
  punctuation marks, so the chunker waits for an ending that never comes: the
  median hold is 2.7–5.8s, against Korean's 1.0s. Then it cuts wherever a pause
  fell. That makes long English clips and sentences cut mid-thought.
- **Fast preachers leave no slack.** In two Cantonese sermons the English audio
  is 98–99% as long as the sermon itself (Korean: 81%), so any delay is
  permanent and the backlog grows.

## Targets (real audio, per 10-minute slice)

- Delay p50 ≤ 6s and p95 ≤ 12s; the backlog stays flat, max ≤ 15s.
- At most 2 broken cuts; flow ≥ 4.4.
- Lines flagged ≤ 5%.
- Korean → English byte-identical to deployed.

## Round 4: the improvement plan (implement first, then measure)

Where the delay comes from, per sentence (median, seconds):

| | Recognition | Hold + translate | To first audio | Waiting behind earlier English | Clip length | Delay |
|---|---|---|---|---|---|---|
| Korean | 0.2 | 1.0 | 0.3 | 3.2 | 4.6 | 6.2 |
| Mandarin | 1.2 | 1.4 | 0.4 | 6.3 | 8.5 | 10.5 |
| Cantonese (fast preacher) | 0.1 | 2.0 | 0.5 | 15.1 | 10.3 | 19.6 |

So Korean is not faster at any single step. It wins because its pieces are
short (the grammar marks every sentence end, so it cuts often and cleanly)
and because its English is only ~81% as long as the speech. Chinese loses on
both counts: few sentence-end signals give long pieces and broken cuts, and
English at 90-97% of the speech leaves no room to catch up.

Three findings drive the plan:

1. **Cantonese text is Traditional; every Chinese rule is Simplified.** The
   chunker's dangling-word and opener lists (因为, 说, 时候, 的话) and the Bible
   book names never match 因為, 說, 時候, 約翰福音, 節. For Cantonese the chunker
   is close to blind, and so is scripture detection.
2. **Chinese has no reliable "this sentence is finished" signal.** Korean has
   final endings (-니다, -요); Chinese has few particles and sparse punctuation.
   Timing knobs (round 1) and pauses alone (round 2) only moved it a little.
3. **The English is too long for fast preachers,** and nothing reacts when the
   listener falls behind.

The plan has five changes. Each is gated to the Chinese directions; Korean code
paths are untouched and the equivalence check must pass after each one.

1. **Script folding.** A 1:1 Traditional→Simplified character map, from OpenCC's
   table (Apache-2.0), used only inside detection. The text the congregation and
   translator see is unchanged. All Mandarin rules and the Bible-book table then
   work on Cantonese text too.
2. **A real Cantonese direction (`yue-en`).** Deepgram nova-3 `zh-HK`, plus:
   - **Sentence rules:** particles 啦 喇 囉 呀 㗎 喎 咩 嘛 吖 啩, tags 係咪 啱唔啱 係唔係, and openers 咁 所以 但係 不過 跟住 之後.
   - **Dangling words:** 嘅 喺 同 畀 將 係 即係 嘅話 嘅時候.
   - **Its own translator prompt:** Cantonese grammar and particles; recogniser
     artefacts (written-Chinese conversion, garbled English code-switching);
     Hong Kong romanisation of names (Chan, Wong, Cheung, not pinyin); church
     terms as Hong Kong churches use them (聖餐, 團契, 崇拜).
   - **Bible references said the Cantonese way:** 廿 (20), 卅 (30), ranges with 至, and Traditional book names.
   - **Traditional keyterms** for recognition.
3. **A completeness check.** A fast model (Haiku 5.5) is asked, after each STT
   final, whether the buffer ends at a complete thought, and if not, where the
   last complete thought ends. It runs in the background, about 0.5s per call.
   - **If complete:** the piece ships after the same short beat as a complete Korean sentence.
   - **If an earlier boundary exists:** the head ships now and the tail waits.
   - **Otherwise:** the existing rules and timers apply.
   - **On failure or timeout:** it falls back to the rules, and is never allowed to block.

   This is the Chinese stand-in for Korean's grammatical endings. It targets
   both the long holds and the broken cuts.
4. **Pacing.**
   - **Concise English (v2):** the rule from round 3, tightened, aiming for about 80% of the speech.
   - **Backlog-aware condensing:** the broadcaster estimates how much English
     audio is queued for listeners. Past about 6s, the translator is told to
     give the shortest faithful rendering (drop repetition and asides, keep every
     claim). Past about 12s, it condenses harder. Scripture, names, numbers and
     church terms are never dropped. The hint goes in the per-segment message, not
     the cached system prompt.
   - **Voice speed** about 1.08 for the Chinese directions only. This needs a listening check before shipping.
5. **The harness models all of it.** The replay simulates the completeness
   check at its measured latency, the backlog the translator would see, and the
   voice speed. Results are cached so variants compare fairly.

**Then measure, in this order:**
1. Replays of every recording (translation only, no voice).
2. The coherence and accuracy judges.
3. Two live runs each of the winner with voice.
4. A side-by-side sample for a native check.

**Shipping:**
- Mandarin changes reach the CBCGL test account only after approval.
- Cantonese also needs the frontend direction option and an `AUTH_DIRECTIONS` entry.
- Pending approval: a speech-recognition bake-off for Cantonese (Scribe, which
  we already pay for, then others).

## Workstreams, in order

### A. Chunking (largest lever)

1. **Timing knobs.** Hold limits, the incomplete-sentence wait and chunk size,
   for Chinese only. Round 1 is running.
2. **Cantonese boundary rules.** The current rules are Mandarin's (了 吗 呢).
   Add Cantonese sentence endings (啦 喇 呀 㗎 喎 咩 嘛 囉 吖) and sentence
   openers (咁 所以 但係 跟住 之後). This needs its own `yue-en` direction.
3. **Pause-aware cuts.** Finals now carry where their speech starts and ends.
   A real pause between finals (≥ ~0.5s) is the strongest sentence-boundary
   signal Chinese gives us, and the chunker ignores it today.
4. **Deepgram endpointing per direction.** Try shorter endpointing, so finals
   (and pauses) arrive sooner for Chinese.
5. **Translator-led segmentation, if 1–4 fall short.** The translator receives
   the buffer, translates the complete thoughts, and hands back the unfinished
   tail, the way a human simultaneous interpreter works.

### B. Pacing and backlog

1. **Concise English.** A length budget in the prompt so the English takes
   about 80% of the source time, not 99%.
2. **Backlog controller.** Past ~6s behind, translate condensed: drop filler
   and repetition, keep the meaning. Past ~12s, merge what's pending into one
   short line. Never drop Scripture, names, numbers or glossary terms.
3. **English voice speed** of about 1.05 for these directions.

### C. Speech recognition

1. **Cantonese bake-off.** Deepgram nova-3 `zh-HK` (today) against ElevenLabs
   Scribe, Soniox, and possibly Google and Azure. Score each on:
   - character error against the two subtitled sermons
   - English mixed into the speech
   - punctuation density, which chunking depends on
   - streaming latency

   New paid providers need approval first.
2. **Mandarin.** Glossary keyterms, and let the translator repair homophone
   errors from context (丢工作 heard as 都工作).
3. **English words inside Cantonese** come out garbled ("bsee" for busy). The
   prompt should recover them from sound.

### D. Translation quality

1. **A proper Cantonese direction** with its own prompt:
   - colloquial particles
   - English kept as spoken
   - Traditional characters
   - Bible references spoken the Cantonese way (廿八節, 十一至二十四節) and
     their garbled forms ("151124")
2. **Judges with references.** Human subtitles as a cleaner source, and the
   English references written for the synthetic sermons.
3. **Model trade-off.** Sonnet 5.5 against Haiku 5.5 (speed) and Opus 5.5
   (quality).

## Test corpus

All of it lives in `recordings/` and is gitignored.

- **Korean:** `korean/audio/sermon_test2.mp4`, 15:00–25:00. The reference.
- **Mandarin:** the real service in `mandarin/audio/`, 15:00–25:00, and the
  synthetic sermon `mandarin/test-material/synthetic-anxiety-peace` (Tingting).
- **Cantonese:** `cantonese/audio/youtube/`, four public sermons:
  - two with human subtitles
  - one sanctuary recording
  - one code-switching service

  Plus the synthetic `cantonese/test-material/synthetic-coming-home`.

## The loop

1. **Fast (minutes):** `evals/chunk-replay.ts` re-chunks a recorded run under a
   simulated clock, with any timing overrides, then translates for real.
   `evals/tune-round.sh` runs variants over the corpus and judges them;
   `evals/scoreboard.py` prints the table. Speech recognition is fixed by the
   recording, so this isolates chunking and translation. Always compare against
   the `~identity` replay, not the live run.
2. **Confirm (real time):** run winners end to end with `evals/pilot-run.ts`,
   twice, because of run-to-run variance.
3. **Guard:** after any change to shared code, the Korean equivalence check
   (deployed vs local translation requests and chunk cuts) must pass.
4. **Native check:** a short `side-by-side.md` sample for review before a
   change ships.
5. **Ship:** a per-direction config change, pushed only with approval and
   never during a service.
