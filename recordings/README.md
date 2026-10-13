# Recordings

Local test media, live-service transcripts and pilot-run output, one folder per
**language the pastor speaks** (the source side of the direction). Everything
here except this README is gitignored: the repository is public and these files
contain a named church's service content.

```
recordings/
  korean/      ko-en
    audio/         recorded services (sermon_test.mp4, sermon_test2.mp4, sermonfinal.mp4)
    transcripts/   what the congregation actually heard at live tests
    runs/<label>/  pilot-run artifacts (messages.jsonl, clips/, summary.json, report.json)
  mandarin/    zh-en
    audio/         recorded services; audio/synthetic/ holds the macOS `say` test sermon
    transcripts/
    runs/<label>/
  english/     en-ko (for later)
```

A new language gets a new folder with the same three subfolders; add its
direction to `SOURCE_LANGUAGE` in `backend/evals/recordings.ts`.

`backend/evals/pilot-run.ts` writes to `recordings/<language>/runs/<label>/`
based on `--direction`, and `pilot-report.ts --label <label>` finds a run in
any language.

```
cd backend
npx tsx evals/pilot-run.ts --direction zh-en --label my-run \
  --media ../recordings/mandarin/audio/<file> [--start 900] [--duration 0]
npx tsx evals/pilot-report.ts --label my-run
```

Recordings live only on the machine that made them. Back them up somewhere
private if they matter.
