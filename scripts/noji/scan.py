"""Scan a notes file for mixed scripts: Cyrillic in German fields / externalId, Latin-only RU fields."""
import json, re, sys
d = json.load(open(sys.argv[1]))
cyr = re.compile(r'[Ѐ-ӿ]')
bad = []
for n in d['notes']:
    f = n['fields']
    for k in ('lemma', 'article', 'plural', 'example', 'praeteritum', 'perfekt', 'rektion'):
        if f.get(k) and cyr.search(f[k]):
            bad.append(f"{n['externalId']}: cyrillic in {k}: {f[k]}")
    if cyr.search(n['externalId']):
        bad.append(f"{n['externalId']}: cyrillic in externalId")
    if f.get('translation') and not cyr.search(f['translation']):
        bad.append(f"{n['externalId']}: translation without cyrillic: {f['translation']}")
print('\n'.join(bad) if bad else 'scan ok', f'({len(d["notes"])} notes)')
