"""One row per run: delay, backlog, chunking and judged quality.
usage: python3 evals/scoreboard.py <run label> [<run label> ...]
Each run needs timing.json (timing-report.ts) and, for quality columns,
judge-live.jsonl and coherence-live-live.jsonl (run-to-replay.ts + judges)."""
import json, os, statistics as st, sys, glob
R = os.path.join(os.path.dirname(__file__), '..', '..', 'recordings')
def find(label):
    hits = glob.glob(os.path.join(R, '*', 'runs', label))
    return hits[0] if hits else None
print('| Run | Delay p50 | Delay p95 | Backlog 1st→last third | Max backlog | Chunks/min | Clip p50 | Lines flagged | Broken cuts | Flow (1-5) |')
print('|---|---|---|---|---|---|---|---|---|---|')
for label in sys.argv[1:]:
    d = find(label)
    if not d or not os.path.exists(d + '/timing.json'):
        print(f'| {label} | (no timing.json) |'); continue
    t = json.load(open(d + '/timing.json')); m = t['metrics']; c = t['chunks']
    clips = [x['clipSec'] for x in c if x['clipSec']]
    q = '— | — | —'
    if os.path.exists(d + '/judge-live.jsonl') and os.path.exists(d + '/coherence-live-live.jsonl'):
        j = [json.loads(x) for x in open(d + '/judge-live.jsonl')]
        co = [json.loads(x) for x in open(d + '/coherence-live-live.jsonl')]
        scores = [x['score'] for x in co if x.get('score')]
        broken = sum(1 for x in co for p in x.get('problems', []) if p.get('type') == 'broken')
        q = f"{sum(1 for x in j if x.get('issues'))}/{len(j)} | {broken} | {sum(scores)/max(1,len(scores)):.2f}"
    print(f"| {label} | {m['lag']['p50']}s | {m['lag']['p95']}s | {m['backlog']['firstThirdAvg']}s → {m['backlog']['lastThirdAvg']}s | {m['backlog']['max']}s | {len(c)/(m['sourceSec']/60):.1f} | {st.median(clips) if clips else 0:.1f}s | {q} |")
