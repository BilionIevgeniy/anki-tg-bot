/**
 * Validates every deck file in decks/ and finds duplicates across files.
 *
 *   npm run cards:check            → validate, exit 1 on errors (used in CI)
 *   npm run cards:check -- --list  → also print every existing word (for the anti-duplicate check)
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { type ImportNote, parseImport } from '../src/import/contract';
import { listDeckFiles } from '../src/sync/deck-sync.service';

const dir = path.resolve(process.cwd(), process.env.DECKS_DIR ?? 'decks');
const list = process.argv.includes('--list');

function wordOf(n: ImportNote): string {
  if (n.type === 'vocab_de') {
    const f = n.fields;
    return [f.article, f.lemma].filter(Boolean).join(' ') + (f.rektion ? ` (${f.rektion})` : '');
  }
  return n.fields.front;
}

let errors = 0;
let warnings = 0;
const byDeck = new Map<string, Map<string, string>>(); // deck → externalId → file
const lemmaIndex = new Map<string, { id: string; file: string; tr: string }[]>(); // deck|lemma → notes
let notes = 0;

for (const file of listDeckFiles(dir)) {
  const rel = path.relative(dir, file);
  const res = parseImport(readFileSync(file, 'utf8'));
  if (!res.ok || !res.data) {
    errors++;
    console.error(`❌ ${rel}\n   ${res.errors.join('\n   ')}`);
    continue;
  }
  const deck = res.data.deck.key;
  const ids = byDeck.get(deck) ?? new Map<string, string>();
  byDeck.set(deck, ids);
  for (const n of res.data.notes) {
    notes++;
    const prev = ids.get(n.externalId);
    if (prev) {
      errors++;
      console.error(`❌ externalId "${n.externalId}" is in both ${prev} and ${rel} (deck ${deck})`);
    }
    ids.set(n.externalId, rel);
    if (n.type === 'vocab_de') {
      const key = `${deck}|${n.fields.lemma.toLowerCase()}`;
      const arr = lemmaIndex.get(key) ?? [];
      arr.push({ id: n.externalId, file: rel, tr: n.fields.translation });
      lemmaIndex.set(key, arr);
    }
    if (list)
      console.log(
        `${deck}\t${n.externalId}\t${wordOf(n)}\t${n.type === 'vocab_de' ? n.fields.translation : ''}`,
      );
  }
}

for (const [key, arr] of lemmaIndex) {
  if (arr.length < 2) continue;
  warnings++;
  console.warn(
    `⚠️  "${key.split('|')[1]}" appears ${arr.length}× — make sure these are different meanings:\n` +
      arr.map((a) => `     ${a.id} — ${a.tr} (${a.file})`).join('\n'),
  );
}

console.log(
  `\n${notes} notes in ${byDeck.size} deck(s); ${errors} error(s), ${warnings} warning(s)`,
);
process.exit(errors ? 1 : 0);
