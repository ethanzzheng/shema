# Recordings

Local test media, live-service transcripts and pilot-run output, one folder per
**language the pastor speaks** (the source side of the direction). Everything
here except this README is gitignored: the repository is public and these files
contain a named church's service content.

```
recordings/
  korean/      ko-en
    audio/          recorded real services (sermon_test.mp4, sermon_test2.mp4, sermonfinal.mp4)
    test-material/  prepared test sermons, one folder each (see below)
    transcripts/    what the congregation actually heard at live tests
    runs/<label>/   pilot-run artifacts (messages.jsonl, clips/, summary.json, report.json)
  mandarin/    zh-en      same four folders
  cantonese/   yue-en     same four folders
  english/     en-ko (for later)
```

Each `test-material/<name>/` folder holds one test sermon:

- `sermon.txt`: the script, in the source language
- `reference-en.txt`: an English reference written with it, paragraph by paragraph, for judging meaning
- `*.aiff` / audio: the sermon read aloud (synthetic ones are macOS `say` voices)
- `stt-<provider>-<model>-<lang>-<voice>.txt`: what a speech-to-text model heard

Synthetic voices are much cleaner than a pastor in a sanctuary. Use them to
build and time the pipeline, not to claim accuracy.

A new language gets a new folder with the same four subfolders; add its
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
