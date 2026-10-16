"""Average each chunking variant over a set of recorded runs.
usage: python3 evals/compare-variants.py "<run> <run> ..." <variant> [<variant> ...]
Needs each <run>~<variant> to have timing.json and the judge outputs."""
import json, os, glob, sys, statistics as st
R = os.path.join(os.path.dirname(__file__), '..', '..', 'recordings')
runs, variants = sys.argv[1].split(), sys.argv[2:]
def load(label):
    d = (glob.glob(os.path.join(R, '*', 'runs', label)) or [None])[0]
    if not d or not os.path.exists(d + '/timing.json'): return None
    t = json.load(open(d + '/timing.json')); m = t['metrics']
    j = [json.loads(x) for x in open(d + '/judge-live.jsonl')] if os.path.exists(d + '/judge-live.jsonl') else []
    co = [json.loads(x) for x in open(d + '/coherence-live-live.jsonl')] if os.path.exists(d + '/coherence-live-live.jsonl') else []
    clips = [c['clipSec'] for c in t['chunks'] if c['clipSec']]
    return dict(p50=m['lag']['p50'] or 0, p95=m['lag']['p95'] or 0, maxb=m['backlog']['max'] or 0,
                chunks=len(t['chunks']), clip=st.median(clips) if clips else 0,
                flagged=sum(1 for x in j if x.get('issues')) / max(1, len(j)),
                broken=sum(1 for x in co for p in x.get('problems', []) if p.get('type') == 'broken'),
                flow=st.mean([x['score'] for x in co if x.get('score')]) if co else 0)
print(f"| Variant | Delay p50 | Delay p95 | Max backlog | Clip p50 | Lines flagged | Broken cuts (total) | Flow |")
print('|---|---|---|---|---|---|---|---|')
for v in variants:
    rows = [r for r in (load(f'{run}~{v}') for run in runs) if r]
    if not rows: print(f'| {v} | (missing) |'); continue
    a = lambda k: st.mean(r[k] for r in rows)
    print(f"| {v} ({len(rows)} runs) | {a('p50'):.1f}s | {a('p95'):.1f}s | {a('maxb'):.1f}s | {a('clip'):.1f}s | {a('flagged'):.0%} | {sum(r['broken'] for r in rows)} | {a('flow'):.2f} |")
