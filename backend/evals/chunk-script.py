"""Print a run as a script: every chunk as it was cut, in the source language,
with its English and the timing between chunks.

usage: python3 evals/chunk-script.py <run label> [--out file.md]

Per chunk:
  sent      when the chunk went to translation (seconds into the sermon)
  +gap      time since the previous chunk was sent
  wait      how long after its speech ended it was sent (chunker hold)
  cut       why the chunker cut there (punct, oracle, pause, timeout, ...)
  heard     when the listener starts hearing it, and the lag behind speech
  silence   dead air the listener sat through before it (gap between clips)
Needs timing.json (timing-report.ts) and messages.jsonl."""
import json, os, sys, glob

R = os.path.join(os.path.dirname(__file__), '..', '..', 'recordings')
args = sys.argv[1:]
out = None
if '--out' in args:
    i = args.index('--out'); out = args[i + 1]; del args[i:i + 2]
label = args[0]
d = glob.glob(os.path.join(R, '*', 'runs', label))[0]
chunks = json.load(open(os.path.join(d, 'timing.json')))['chunks']
meta = {}
for line in open(os.path.join(d, 'messages.jsonl')):
    m = json.loads(line)
    if m.get('type') == 'translation' and m.get('src') == 'broadcaster':
        meta[m['seq']] = m

def mmss(s):
    return f'{int(s // 60)}:{s % 60:04.1f}' if s is not None else '—'

lines = [f'# {label}', '']
gaps, waits, silences = [], [], []
prev_sent = prev_end = None
for c in chunks:
    m = meta.get(c['seq'], {})
    sent = m.get('dispatchedAt')
    gap = sent - prev_sent if sent is not None and prev_sent is not None else None
    # Speech end is estimated from word times, so a chunk sent the moment it
    # ended can read a hair negative.
    wait = max(0.0, sent - c['speechEnd']) if sent is not None and c.get('speechEnd') is not None else None
    silence = c['playStart'] - prev_end if c.get('playStart') is not None and prev_end is not None else None
    if gap is not None: gaps.append(gap)
    if wait is not None: waits.append(wait)
    if silence is not None and silence > 0.05: silences.append(silence)
    head = [f"**#{c['seq']}**", f'sent {mmss(sent)}']
    if gap is not None: head.append(f'+{gap:.1f}s')
    if wait is not None: head.append(f'wait {wait:.1f}s')
    head.append(f"cut: {m.get('cutReason', '?')}")
    if c.get('playStart') is not None:
        head.append(f"heard {mmss(c['playStart'])}" + (f" (lag {c['lag']:.1f}s)" if c.get('lag') is not None else ''))
    if silence is not None and silence > 0.05: head.append(f'silence {silence:.1f}s')
    lines += ['  ·  '.join(head), f"> {c['source']}", f"> *{c['translation']}*", '']
    if sent is not None: prev_sent = sent
    if c.get('playEnd') is not None: prev_end = c['playEnd']

def med(xs):
    s = sorted(xs); return s[len(s) // 2] if s else 0

summary = [
    f'{len(chunks)} chunks · median gap between chunks {med(gaps):.1f}s · median wait after speech {med(waits):.1f}s',
    f'listener heard dead air {len(silences)} times, {sum(silences):.0f}s in total (longest {max(silences, default=0):.1f}s)',
    '',
]
text = '\n'.join(lines[:2] + summary + lines[2:])
if out:
    open(out, 'w').write(text)
    print(f'wrote {out}')
print('\n'.join(summary))
