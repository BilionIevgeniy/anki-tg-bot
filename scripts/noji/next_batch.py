"""Print the next N unprocessed Noji groups (JSON) to clean into cards.

Usage: python3 scripts/noji/next_batch.py 50 > /tmp/batch_src.json
"""
import json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / 'sources' / 'noji'
n = int(sys.argv[1]) if len(sys.argv) > 1 else 50
groups = json.loads((ROOT / 'groups.json').read_text())
done = set(json.loads((ROOT / 'processed.json').read_text()))
todo = [k for k in groups if k not in done]
batch = {k: groups[k] for k in todo[:n]}
print(json.dumps(batch, ensure_ascii=False, indent=1))
print(f'# {len(batch)} groups in this batch, {len(todo) - len(batch)} left after it, {len(done)} done', file=sys.stderr)
