"""Noji export (.ofc) -> sources/noji/groups.json (cards grouped by German head word).

Usage: python3 scripts/noji/extract.py sources/noji/<export>.ofc
Needs: pip install zstandard  (only for this one-time step)
"""
import collections, html, io, json, re, sys, zipfile
from pathlib import Path

import zstandard  # noqa: E402

OUT = Path(__file__).resolve().parents[2] / 'sources' / 'noji' / 'groups.json'


def clean(s):
    s = re.sub(r'</p>\s*<p>', '\n', s or '')
    s = re.sub(r'<br\s*/?>', '\n', s)
    s = re.sub(r'<[^>]+>', '', s)
    s = html.unescape(s).replace('\xa0', ' ').replace('​', '')
    return ' / '.join(l.strip(' /') for l in s.split('\n') if l.strip(' /'))


def head_of(de):
    head = re.split(r'\s[–—-]\s|\s/\s[–—-]', de, maxsplit=1)[0]
    return re.sub(r'\(.*?\)', '', head).strip(' ,;./')


def norm(s):
    return re.sub(r'^(der|die|das|sich)\s+', '', s.lower()).strip()


def main(path):
    z = zipfile.ZipFile(path)
    raw = zstandard.ZstdDecompressor().stream_reader(io.BytesIO(z.read('deck_export_data'))).read()
    deck = json.loads(raw)[0]
    groups = collections.defaultdict(list)
    for n in deck['notes']:
        p = n['progresses'][0]
        de, ru = clean(n['fields']['back_side']), clean(n['fields']['front_side'])
        groups[norm(head_of(de))].append({
            'id': n['id'], 'de': de, 'ru': ru, 'state': p['learning_state'],
            'interval_min': p['interval'], 'ease': p['ease_factor'], 'next': p['next_review_at'],
        })
    # order: groups with progress first (learned words get migrated early), then the rest
    def order(item):
        k, cards = item
        best = max((c['interval_min'] or 0) for c in cards)
        return (0 if any(c['state'] != 'new' for c in cards) else 1, -best, k)
    data = dict(sorted(groups.items(), key=order))
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1))
    print(f'{sum(len(v) for v in data.values())} cards -> {len(data)} groups -> {OUT}')


if __name__ == '__main__':
    main(sys.argv[1])
