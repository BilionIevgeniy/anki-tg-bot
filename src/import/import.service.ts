import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, max, notInArray, sql } from 'drizzle-orm';
import { templatesFor, type Template } from '../cards/templates';
import { DB, type Db, type Tx } from '../db/db.module';
import { cards, decks, notes } from '../db/schema';
import { State } from '../srs/fsrs.core';
import type { ImportFile, ImportNote, SrsState } from './contract';

export interface ImportReport {
  deckKey: string;
  deckName: string;
  deckExists: boolean;
  created: number;
  updated: number;
  unchanged: number;
  cardsCreated: number;
  /** How many created cards came with migrated memory state */
  withProgress: number;
}

const STATE_MAP: Record<SrsState['state'], State> = {
  new: State.New,
  learning: State.Learning,
  review: State.Review,
  relearning: State.Relearning,
};

/** Stable JSON (sorted keys) so the hash does not depend on key order. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function contentHash(n: ImportNote): string {
  const reverse = n.type === 'basic' ? n.reverse : undefined;
  return createHash('sha256')
    .update(stable({ type: n.type, fields: n.fields, tags: n.tags, reverse }))
    .digest('hex')
    .slice(0, 32);
}

function noteFields(n: ImportNote): Record<string, unknown> {
  // `reverse` lives in fields so templatesFor() can see it later
  return n.type === 'basic' ? { ...n.fields, reverse: n.reverse } : { ...n.fields };
}

function srsFor(n: ImportNote, template: Template): SrsState | undefined {
  const srs: Partial<Record<Template, SrsState>> | undefined = n.srs;
  return srs?.[template];
}

const CHUNK = 500;

/**
 * Brings a note's cards in line with its content after the content changed (re-import or an
 * edit in the Mini App). Memory state is never touched:
 *  - a template that no longer applies (article removed, reverse off) → its card is suspended;
 *  - a template that came back → its card is unsuspended (leeches stay suspended);
 *  - a new template (article added) → a new card is created.
 * Returns how many cards were created.
 */
export async function syncNoteCards(
  tx: Tx,
  n: {
    userId: number;
    deckId: number;
    noteId: number;
    type: string;
    fields: Record<string, unknown>;
  },
): Promise<number> {
  const tpls = templatesFor({ type: n.type, fields: n.fields });
  await tx
    .update(cards)
    .set({ suspended: true })
    .where(
      and(eq(cards.noteId, n.noteId), tpls.length ? notInArray(cards.template, tpls) : undefined),
    );
  if (!tpls.length) return 0;
  await tx
    .update(cards)
    .set({ suspended: false })
    .where(
      and(
        eq(cards.noteId, n.noteId),
        inArray(cards.template, tpls),
        eq(cards.suspended, true),
        eq(cards.isLeech, false),
      ),
    );
  const res = await tx
    .insert(cards)
    .values(
      tpls.map((template) => ({ userId: n.userId, deckId: n.deckId, noteId: n.noteId, template })),
    )
    .onConflictDoNothing({ target: [cards.noteId, cards.template] })
    .returning({ id: cards.id });
  return res.length;
}

@Injectable()
export class ImportService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Dry run: what would happen, without writing anything. */
  async preview(userId: number, file: ImportFile): Promise<ImportReport> {
    return this.run(this.db as unknown as Tx, userId, file, true);
  }

  async apply(userId: number, file: ImportFile): Promise<ImportReport> {
    return this.db.transaction(async (tx) => {
      // one import per user at a time (double "✅" tap, Telegram retry, deck sync on start)
      await tx.execute(sql`select pg_advisory_xact_lock(${userId})`);
      return this.run(tx, userId, file, false);
    });
  }

  private async run(
    tx: Tx,
    userId: number,
    file: ImportFile,
    dryRun: boolean,
  ): Promise<ImportReport> {
    let [deck] = await tx
      .select()
      .from(decks)
      .where(and(eq(decks.userId, userId), eq(decks.key, file.deck.key)));
    const deckExists = !!deck;

    const report: ImportReport = {
      deckKey: file.deck.key,
      deckName: file.deck.name,
      deckExists,
      created: 0,
      updated: 0,
      unchanged: 0,
      cardsCreated: 0,
      withProgress: 0,
    };

    const existing = new Map<
      string,
      { id: number; contentHash: string; editedAt: Date | null; deletedAt: Date | null }
    >();
    if (deck) {
      const ids = file.notes.map((n) => n.externalId);
      for (let i = 0; i < ids.length; i += CHUNK) {
        const rows = await tx
          .select({
            id: notes.id,
            externalId: notes.externalId,
            contentHash: notes.contentHash,
            editedAt: notes.editedAt,
            deletedAt: notes.deletedAt,
          })
          .from(notes)
          .where(
            and(eq(notes.deckId, deck.id), inArray(notes.externalId, ids.slice(i, i + CHUNK))),
          );
        rows.forEach((r) => existing.set(r.externalId, r));
      }
    }

    const toCreate: ImportNote[] = [];
    const toUpdate: { id: number; note: ImportNote; hash: string }[] = [];
    for (const n of file.notes) {
      const hash = contentHash(n);
      const ex = existing.get(n.externalId);
      if (!ex) toCreate.push(n);
      // edited or deleted by the user in the Mini App → the user's version wins over the file
      else if (ex.editedAt || ex.deletedAt) report.unchanged++;
      else if (ex.contentHash !== hash) toUpdate.push({ id: ex.id, note: n, hash });
      else report.unchanged++;
    }
    report.created = toCreate.length;
    report.updated = toUpdate.length;
    for (const n of toCreate) {
      const tpls = templatesFor({ type: n.type, fields: noteFields(n) });
      report.cardsCreated += tpls.length;
      report.withProgress += tpls.filter((t) => srsFor(n, t)).length;
    }
    // migrated progress for notes that already exist: only for cards never studied in the bot
    const progressFor = file.notes.filter((n) => {
      const ex = existing.get(n.externalId);
      return n.srs && ex && !ex.deletedAt;
    });
    if (dryRun) return report;

    if (!deck) {
      [deck] = await tx
        .insert(decks)
        .values({
          userId,
          key: file.deck.key,
          name: file.deck.name,
          description: file.deck.description,
        })
        .returning();
    } else if (
      deck.name !== file.deck.name ||
      (file.deck.description && deck.description !== file.deck.description)
    ) {
      await tx
        .update(decks)
        .set({ name: file.deck.name, description: file.deck.description ?? deck.description })
        .where(eq(decks.id, deck.id));
    }
    const deckId = deck!.id;

    // Updates: content only. Memory state of existing cards is NEVER touched.
    for (const u of toUpdate) {
      await tx
        .update(notes)
        .set({
          type: u.note.type,
          fields: noteFields(u.note),
          tags: u.note.tags,
          contentHash: u.hash,
        })
        .where(eq(notes.id, u.id));
      report.cardsCreated += await syncNoteCards(tx, {
        userId,
        deckId,
        noteId: u.id,
        type: u.note.type,
        fields: noteFields(u.note),
      });
    }

    // Creates, in bulk, keeping file order for the "new cards" queue
    const [{ maxPos } = { maxPos: 0 }] = await tx
      .select({ maxPos: max(notes.position) })
      .from(notes)
      .where(eq(notes.deckId, deckId));
    let position = (maxPos ?? 0) + 1;

    for (let i = 0; i < toCreate.length; i += CHUNK) {
      const chunk = toCreate.slice(i, i + CHUNK);
      const inserted = await tx
        .insert(notes)
        .values(
          chunk.map((n) => ({
            userId,
            deckId,
            externalId: n.externalId,
            type: n.type,
            fields: noteFields(n),
            tags: n.tags,
            contentHash: contentHash(n),
            position: position++,
          })),
        )
        .returning({ id: notes.id, externalId: notes.externalId });
      const idByExt = new Map(inserted.map((r) => [r.externalId, r.id]));

      const cardValues = chunk.flatMap((n) =>
        templatesFor({ type: n.type, fields: noteFields(n) }).map((template) => {
          const s = srsFor(n, template);
          return {
            userId,
            deckId,
            noteId: idByExt.get(n.externalId)!,
            template,
            ...(s
              ? {
                  state: STATE_MAP[s.state],
                  due: new Date(s.due),
                  stability: s.stability,
                  difficulty: s.difficulty,
                  reps: s.reps,
                  lapses: s.lapses,
                  scheduledDays: s.scheduledDays,
                  lastReview: s.lastReview ? new Date(s.lastReview) : null,
                }
              : {}),
          };
        }),
      );
      for (let j = 0; j < cardValues.length; j += CHUNK) {
        await tx.insert(cards).values(cardValues.slice(j, j + CHUNK));
      }
    }

    // A note that was imported earlier without progress can receive it later (e.g. a duplicate
    // from another Noji batch was merged into it) — but ONLY while the card is untouched:
    // state New and no reviews. Real progress from the bot is never overwritten.
    for (const n of progressFor) {
      const noteId = existing.get(n.externalId)!.id;
      for (const [template, st] of Object.entries(n.srs ?? {}) as [Template, SrsState][]) {
        const res = await tx
          .update(cards)
          .set({
            state: STATE_MAP[st.state],
            due: new Date(st.due),
            stability: st.stability,
            difficulty: st.difficulty,
            reps: st.reps,
            lapses: st.lapses,
            scheduledDays: st.scheduledDays,
            lastReview: st.lastReview ? new Date(st.lastReview) : null,
            version: sql`${cards.version} + 1`,
          })
          .where(
            and(
              eq(cards.noteId, noteId),
              eq(cards.template, template),
              eq(cards.state, State.New),
              eq(cards.reps, 0),
              sql`not exists (select 1 from review_logs rl where rl.card_id = ${cards.id})`,
            ),
          )
          .returning({ id: cards.id });
        report.withProgress += res.length;
      }
    }
    return report;
  }

  /** Export a deck in the same contract format (with memory state) — a backup you can re-import. */
  async exportDeck(userId: number, deckId: number): Promise<ImportFile | null> {
    const [deck] = await this.db
      .select()
      .from(decks)
      .where(and(eq(decks.id, deckId), eq(decks.userId, userId)));
    if (!deck) return null;
    const noteRows = await this.db
      .select()
      .from(notes)
      .where(and(eq(notes.deckId, deck.id), isNull(notes.deletedAt)))
      .orderBy(asc(notes.position));
    const cardRows = await this.db.select().from(cards).where(eq(cards.deckId, deck.id));
    const byNote = new Map<number, typeof cardRows>();
    cardRows.forEach((c) => byNote.set(c.noteId, [...(byNote.get(c.noteId) ?? []), c]));
    const STATE_NAME = ['new', 'learning', 'review', 'relearning'] as const;

    const out = noteRows.map((n) => {
      const srs: Record<string, SrsState> = {};
      for (const c of byNote.get(n.id) ?? []) {
        if (c.state === Number(State.New)) continue;
        srs[c.template] = {
          state: STATE_NAME[c.state] ?? 'review',
          due: c.due.toISOString(),
          stability: c.stability,
          difficulty: c.difficulty,
          reps: c.reps,
          lapses: c.lapses,
          scheduledDays: c.scheduledDays,
          ...(c.lastReview ? { lastReview: c.lastReview.toISOString() } : {}),
        };
      }
      const { reverse, ...fields } = n.fields as Record<string, unknown> & { reverse?: boolean };
      return {
        externalId: n.externalId,
        type: n.type,
        fields,
        tags: n.tags,
        ...(n.type === 'basic' ? { reverse: !!reverse } : {}),
        ...(Object.keys(srs).length ? { srs } : {}),
      };
    });
    return {
      schemaVersion: 1,
      deck: {
        key: deck.key,
        name: deck.name,
        ...(deck.description ? { description: deck.description } : {}),
      },
      notes: out as ImportFile['notes'],
    };
  }
}
