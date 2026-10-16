"""Where two runs cut the same transcript: fraction of cut points they share.
usage: python3 evals/boundary-agreement.py <runA dir> <runB dir>"""
import json, re, sys
def cuts(d):
    pos, out = 0, set()
    for l in open(d + '/messages.jsonl'):
        m = json.loads(l)
        if m.get('src') == 'broadcaster' and m['type'] == 'translation':
            pos += len(re.sub(r'[\s\W]+', '', m['korean'])); out.add(pos)
    return out
a, b = cuts(sys.argv[1]), cuts(sys.argv[2])
print(f"cuts A {len(a)}, B {len(b)}, shared {len(a & b)} ({len(a & b) / max(1, len(a | b)):.0%} of all cut points)")
