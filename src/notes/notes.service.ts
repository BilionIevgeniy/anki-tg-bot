import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { cards, notes } from '../db/schema';
import { basicFields, vocabDeFields } from '../import/contract';
import { syncNoteCards } from '../import/import.service';

export type EditResult =
  | { ok: true; noteId: number }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'invalid'; errors: string[] };

/** Empty inputs from the form mean "no value": "" / "   " → field removed. */
function clean(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') {
      const t = v.trim();
      if (t) out[k] = t;
    } else if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Editing and deleting a word from the Mini App. The note is found through one of its cards
 * (the card the user is looking at). Memory state of the cards is never touched.
 */
@Injectable()
export class NotesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async noteOfCard(userId: number, cardId: number) {
    const [row] = await this.db
      .select({ note: notes })
      .from(cards)
      .innerJoin(notes, eq(notes.id, cards.noteId))
      .where(and(eq(cards.id, cardId), eq(cards.userId, userId), isNull(notes.deletedAt)));
    return row?.note;
  }

  /**
   * Replaces the note's fields. Afterwards the deck sync no longer overwrites this note
   * (editedAt is set). Cards follow the content: e.g. an added article creates the
   * der/die/das card, a removed one suspends it.
   */
  async edit(
    userId: number,
    cardId: number,
    rawFields: Record<string, unknown>,
  ): Promise<EditResult> {
    const note = await this.noteOfCard(userId, cardId);
    if (!note) return { ok: false, reason: 'not_found' };

    const input = clean(rawFields);
    let fields: Record<string, unknown>;
    if (note.type === 'vocab_de') {
      const res = vocabDeFields.safeParse(input);
      if (!res.success)
        return { ok: false, reason: 'invalid', errors: res.error.issues.map(issue) };
      fields = res.data;
    } else {
      const res = basicFields.safeParse(input);
      if (!res.success)
        return { ok: false, reason: 'invalid', errors: res.error.issues.map(issue) };
      // the reverse switch is a deck-file setting, not editable here
      fields = { ...res.data, reverse: !!(note.fields as { reverse?: boolean }).reverse };
    }

    const done = await this.db.transaction(async (tx) => {
      // same lock as the import: a deck sync running right now cannot overwrite this edit
      await tx.execute(sql`select pg_advisory_xact_lock(${userId})`);
      const updated = await tx
        .update(notes)
        .set({ fields, editedAt: new Date() })
        .where(and(eq(notes.id, note.id), eq(notes.userId, userId), isNull(notes.deletedAt)))
        .returning({ id: notes.id });
      if (!updated.length) return false; // deleted meanwhile (double tap, second window)
      await syncNoteCards(tx, {
        userId,
        deckId: note.deckId,
        noteId: note.id,
        type: note.type,
        fields,
      });
      return true;
    });
    return done ? { ok: true, noteId: note.id } : { ok: false, reason: 'not_found' };
  }

  /**
   * Soft delete: the word and all its cards leave the queue and every counter; the deck sync
   * never brings it back. Progress rows stay in the database (nothing is lost for good).
   */
  async remove(userId: number, cardId: number): Promise<boolean> {
    const note = await this.noteOfCard(userId, cardId);
    if (!note) return false;
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${userId})`);
      const updated = await tx
        .update(notes)
        .set({ deletedAt: new Date() })
        .where(and(eq(notes.id, note.id), eq(notes.userId, userId), isNull(notes.deletedAt)))
        .returning({ id: notes.id });
      if (!updated.length) return false;
      await tx.update(cards).set({ suspended: true }).where(eq(cards.noteId, note.id));
      return true;
    });
  }
}

const FIELD_NAMES: Record<string, string> = {
  lemma: 'Слово',
  translation: 'Перевод',
  article: 'Артикль',
  pos: 'Часть речи',
  register: 'Стиль',
  front: 'Вопрос',
  back: 'Ответ',
};

function issue(i: { path: PropertyKey[]; message: string; code?: string }): string {
  const key = String(i.path[0] ?? '');
  return `${FIELD_NAMES[key] ?? key}: ${i.code === 'too_small' || /required|expected string/i.test(i.message) ? 'обязательное поле' : i.message}`;
}
