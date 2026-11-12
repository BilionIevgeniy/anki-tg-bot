"""Move Noji progress of a dropped duplicate group onto the note that was kept (in another deck file).

Usage: python3 scripts/noji/move_progress.py decks/de/0006-noji-b06.json de:ansatz "ansatz; ansätze"
The kept note gets srs.ru_de from the best card of the group, if that is stronger than what it has.
The bot applies it on the next deploy only if the card was never studied there.
"""
import importlib.util, json, sys
from pathlib import Path

spec = importlib.util.spec_from_file_location('ap', Path(__file__).with_name('attach_progress.py'))
ap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ap)


def main(deck_file, external_id, *group_keys):
    data = json.loads(Path(deck_file).read_text())
    note = next(n for n in data['notes'] if n['externalId'] == external_id)
    best = None
    for key in group_keys:
        _, cards = ap.cards_for(key)
        for c in cards or []:
            srs = ap.to_srs(c) if c['state'] != 'new' else None
            if srs and (best is None or srs['stability'] > best['stability']):
                best = srs
    current = (note.get('srs') or {}).get('ru_de')
    if best and (current is None or best['stability'] > current['stability']):
        note.setdefault('srs', {})['ru_de'] = best
        Path(deck_file).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
        print(f'{external_id}: progress set (stability {best["stability"]})')
    else:
        print(f'{external_id}: nothing to move')


if __name__ == '__main__':
    main(*sys.argv[1:])
