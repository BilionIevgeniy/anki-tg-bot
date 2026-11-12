"""Attach Noji learning progress to cleaned notes, write a deck file, mark groups as processed.

Input: a deck file (contract v1) whose notes carry an extra "_src" field:
  "_src": "<noji group key>"         progress of the best card of that group
  "_src": "<key>#noun" / "<key>#verb" only cards starting / not starting with der/die/das
  "_src": "__none__"                 no progress (new meaning, split-off word, new word)
Usage: python3 scripts/noji/attach_progress.py /tmp/notes.json decks/de/0002-noji.json
"""
import json, math, sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / 'sources' / 'noji'
groups = json.loads((ROOT / 'groups.json').read_text())
processed_path = ROOT / 'processed.json'
processed = json.loads(processed_path.read_text())

ARTICLES = ('der ', 'die ', 'das ')


def cards_for(src):
    key, _, part = src.partition('#')
    cards = groups.get(key)
    if cards is None:
        return key, None
    if part == 'noun':
        cards = [c for c in cards if c['de'].lower().startswith(ARTICLES)]
    elif part == 'verb':
        cards = [c for c in cards if not c['de'].lower().startswith(ARTICLES)]
    return key, cards


def iso(d):
    return d.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')


def to_srs(c):
    """Noji (SM-2, interval in minutes) -> FSRS state. At 90% retention stability ≈ interval."""
    if c['state'] == 'graduated' and c['interval_min']:
        days = c['interval_min'] / 1440
        due = datetime.fromisoformat(c['next'].replace('Z', '+00:00'))
        ease = c['ease'] or 250
        return {
            'state': 'review', 'due': iso(due),
            'stability': round(max(days, 1), 2),
            'difficulty': round(min(10, max(1, 5 + (250 - ease) / 30)), 2),
            'reps': max(2, round(math.log2(max(days, 1))) + 2), 'lapses': 0,
            'scheduledDays': max(1, round(days)), 'lastReview': iso(due - timedelta(days=days)),
        }
    if c['state'] == 'learning':
        return {'state': 'learning', 'due': c['next'] or iso(datetime.now(timezone.utc)),
                'stability': 0.5, 'difficulty': 6, 'reps': 1, 'lapses': 0, 'scheduledDays': 0}
    return None


def main(src_path, out_path):
    data = json.loads(Path(src_path).read_text())
    used, missing, with_progress = set(), [], 0
    for note in data['notes']:
        src = note.pop('_src', '__none__')
        if src == '__none__':
            continue
        key, cards = cards_for(src)
        if cards is None:
            missing.append(src)
            continue
        used.add(key)
        best = sorted([c for c in cards if c['state'] != 'new'],
                      key=lambda c: (c['state'] == 'graduated', c['interval_min'] or 0), reverse=True)
        srs = to_srs(best[0]) if best else None
        if srs:
            note['srs'] = {'ru_de': srs}  # Noji showed RU → DE
            with_progress += 1
    if missing:
        sys.exit(f'unknown _src keys: {missing}')
    Path(out_path).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    processed_path.write_text(json.dumps(sorted(set(processed) | used), ensure_ascii=False, indent=1) + '\n')
    print(f'{len(data["notes"])} notes, {with_progress} with progress, {len(used)} groups marked processed -> {out_path}')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
