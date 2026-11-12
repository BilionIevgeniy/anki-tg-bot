/**
 * Validates a cleaned Noji batch before progress is attached.
 *
 *   npx ts-node --transpile-only scripts/noji/validate-batch.ts <batch_src.json> <batch_notes.json>
 *
 * Checks: contract v1 (zod), every group of the source batch is either referenced by a note's
 * "_src" or listed in "_dropped" (with a reason), "_src" keys exist in the batch, no duplicate
 * externalIds, no clash with externalIds already in decks/.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseImport } from '../../src/import/contract';
import { listDeckFiles } from '../../src/sync/deck-sync.service';

const [srcPath, notesPath] = process.argv.slice(2);
if (!srcPath || !notesPath) {
  console.error('usage: validate-batch.ts <batch_src.json> <batch_notes.json>');
  process.exit(2);
}

const src = JSON.parse(readFileSync(srcPath, 'utf8')) as Record<string, unknown[]>;
const raw = JSON.parse(readFileSync(notesPath, 'utf8')) as {
  notes?: { _src?: string; externalId?: string }[];
  _dropped?: { key: string; reason: string }[];
  [k: string]: unknown;
};

const errors: string[] = [];
const covered = new Set<string>();
for (const [i, n] of (raw.notes ?? []).entries()) {
  if (!n._src) {
    errors.push(`notes[${i}] (${n.externalId}): missing "_src"`);
    continue;
  }
  if (n._src === '__none__') continue;
  const key = n._src.replace(/#(noun|verb)$/, '');
  if (!(key in src))
    errors.push(`notes[${i}] (${n.externalId}): _src "${n._src}" is not a group of this batch`);
  covered.add(key);
}
for (const d of raw._dropped ?? []) {
  if (!(d.key in src)) errors.push(`_dropped: "${d.key}" is not a group of this batch`);
  if (!d.reason) errors.push(`_dropped: "${d.key}" has no reason`);
  covered.add(d.key);
}
const missing = Object.keys(src).filter((k) => !covered.has(k));
if (missing.length)
  errors.push(
    `groups not covered by any note or _dropped: ${missing.map((k) => `"${k}"`).join(', ')}`,
  );

// contract check without the helper fields
const clean = { ...raw, notes: (raw.notes ?? []).map(({ _src: _s, ...rest }) => rest) };
delete clean._dropped;
const parsed = parseImport(JSON.stringify(clean));
if (!parsed.ok) errors.push(...parsed.errors.map((e) => `contract: ${e}`));

// clashes with what is already in decks/
const decksDir = path.resolve(__dirname, '../../decks');
const existing = new Map<string, string>();
for (const file of listDeckFiles(decksDir)) {
  const res = parseImport(readFileSync(file, 'utf8'));
  res.data?.notes.forEach((n) =>
    existing.set(`${res.data!.deck.key}|${n.externalId}`, path.relative(decksDir, file)),
  );
}
const deckKey = parsed.data?.deck.key ?? 'de';
for (const n of parsed.data?.notes ?? []) {
  const where = existing.get(`${deckKey}|${n.externalId}`);
  if (where && path.resolve(decksDir, where) !== path.resolve(notesPath)) {
    errors.push(`externalId "${n.externalId}" already exists in decks/${where}`);
  }
}

const notes = parsed.data?.notes.length ?? raw.notes?.length ?? 0;
if (errors.length) {
  console.error(`❌ ${errors.length} problem(s):\n - ${errors.join('\n - ')}`);
  process.exit(1);
}
console.log(
  `✅ ${notes} notes, ${Object.keys(src).length} groups covered (${raw._dropped?.length ?? 0} dropped)`,
);
