"""Resolve externalId clashes of a batch with decks/: same meaning → drop from batch and move progress
to the existing note; different meaning → print and exit 1 for manual handling."""
import json, re, subprocess, sys
from pathlib import Path
B = sys.argv[1]
root = Path('/home/claude/anki-tg-bot')
notes_p = Path(f'/home/claude/noji-work/{B}_notes.json')
data = json.loads(notes_p.read_text())
existing = {}
for f in sorted((root / 'decks').rglob('*.json')):
    if f.name.endswith(f'-{B}.json'):
        continue
    for n in json.loads(f.read_text())['notes']:
        existing[n['externalId']] = (f, n)
words = lambda s: set(w for w in re.findall(r'[а-яё]{3,}', s.lower()))
keep, manual = [], []
for n in data['notes']:
    hit = existing.get(n['externalId'])
    if not hit:
        keep.append(n); continue
    f, old = hit
    if words(old['fields']['translation']) & words(n['fields']['translation']):
        src = n.get('_src', '__none__')
        if src != '__none__':
            key = src.split('#')[0]
            subprocess.run(['python3', '-I', str(root / 'scripts/noji/move_progress.py'), str(f), n['externalId'], key], check=True)
            if not any(m is not n and m.get('_src', '').split('#')[0] == key for m in data['notes']):
                data.setdefault('_dropped', []).append({'key': key, 'reason': f"дубль {n['externalId']} в {f.relative_to(root)}"})
        print(f"dropped duplicate {n['externalId']} (kept {f.name})")
    else:
        manual.append(f"{n['externalId']}: '{n['fields']['translation']}' vs existing '{old['fields']['translation']}' in {f.name}")
        keep.append(n)
data['notes'] = keep
notes_p.write_text(json.dumps(data, ensure_ascii=False, indent=2))
if manual:
    print('MANUAL:\n' + '\n'.join(manual)); sys.exit(1)
