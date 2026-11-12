#!/bin/bash
# Merge a cleaned + linguist-reviewed batch into the bot:
#   bash scripts/noji/merge.sh b09
# scan → dedupe vs decks/ (moves Noji progress) → validate → attach progress → decks/de/00NN-noji-bNN.json
set -e
B=$1; N=${B#b}
ROOT=$(cd "$(dirname "$0")/../.." && pwd); W=$ROOT/sources/noji/work
cd "$ROOT"
python3 -I scripts/noji/scan.py $W/${B}_notes.json | tee /tmp/scan_$B.txt
grep -q "scan ok" /tmp/scan_$B.txt || { echo "SCAN FAILED"; exit 1; }
python3 -I scripts/noji/dedupe.py $B
npx ts-node --transpile-only scripts/noji/validate-batch.ts $W/${B}_src.json $W/${B}_notes.json
python3 -I scripts/noji/attach_progress.py $W/${B}_notes.json decks/de/00${N}-noji-${B}.json $W/${B}_src.json
rm -f $W/${B}_notes.json $W/${B}_src.json
npm run -s cards:check 2>&1 | grep -E "❌|notes in"
