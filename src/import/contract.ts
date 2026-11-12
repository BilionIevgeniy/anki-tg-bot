/**
 * Import contract v1 — the JSON format Claude produces in chat and the bot imports.
 * Human docs: docs/IMPORT_FORMAT.md. Keep both in sync.
 */
import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);
const optText = z.string().trim().min(1).optional();

export const ARTICLES = ['der', 'die', 'das'] as const;
export type Article = (typeof ARTICLES)[number];

export const vocabDeFields = z.object({
  /** Word WITHOUT article: "Gerät", "sich kümmern", "ausgezeichnet". */
  lemma: nonEmpty,
  article: z.enum(ARTICLES).optional(),
  plural: optText,
  pos: z.enum(['noun', 'verb', 'adj', 'adv', 'phrase', 'other']).default('other'),
  /** Translation shown on the back (RU, may include EN). */
  translation: nonEmpty,
  /** Disambiguating hint for the RU→DE side, e.g. "техника, прибор". */
  hint: optText,
  example: optText,
  exampleTranslation: optText,
  /** Verb forms, e.g. { praeteritum: "kümmerte", perfekt: "hat gekümmert" } */
  praeteritum: optText,
  perfekt: optText,
  /** Government/collocation: "um + Akk" */
  rektion: optText,
  register: z.enum(['umgs', 'neutral', 'formell']).optional(),
  /** Warning about a false friend, e.g. "≠ рус. «фамилия»" */
  falseFriend: optText,
  note: optText,
});
export type VocabDeFields = z.infer<typeof vocabDeFields>;

export const basicFields = z.object({
  front: nonEmpty,
  back: nonEmpty,
  extra: optText,
});
export type BasicFields = z.infer<typeof basicFields>;

/** Optional memory state to migrate progress (e.g. from Anki). Applied only when a card is created. */
export const srsState = z.object({
  state: z.enum(['new', 'learning', 'review', 'relearning']),
  due: z.iso.datetime({ offset: true }),
  stability: z.number().min(0),
  difficulty: z.number().min(0).max(10),
  reps: z.number().int().min(0).default(0),
  lapses: z.number().int().min(0).default(0),
  scheduledDays: z.number().int().min(0).default(0),
  lastReview: z.iso.datetime({ offset: true }).optional(),
});
export type SrsState = z.infer<typeof srsState>;

const externalId = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[\p{L}\p{N}_:.\-/]+$/u, 'externalId: только буквы, цифры и _ : . - /');

const tags = z.array(z.string().trim().min(1).max(50)).max(20).default([]);

export const vocabDeNote = z.object({
  externalId,
  type: z.literal('vocab_de'),
  fields: vocabDeFields,
  tags,
  /** Keys: "de_ru" | "ru_de" | "article" */
  srs: z.partialRecord(z.enum(['de_ru', 'ru_de', 'article']), srsState).optional(),
});

export const basicNote = z.object({
  externalId,
  type: z.literal('basic'),
  fields: basicFields,
  tags,
  /** Also create the back→front card. */
  reverse: z.boolean().default(false),
  srs: z.partialRecord(z.enum(['fwd', 'rev']), srsState).optional(),
});

export const importNote = z.discriminatedUnion('type', [vocabDeNote, basicNote]);
export type ImportNote = z.infer<typeof importNote>;

export const importFile = z
  .object({
    schemaVersion: z.literal(1),
    deck: z.object({
      key: z
        .string()
        .trim()
        .min(1)
        .max(50)
        .regex(/^[a-z0-9][a-z0-9_-]*$/, 'deck.key: латиница в нижнем регистре, цифры, - и _'),
      name: z.string().trim().min(1).max(80),
      description: z.string().trim().max(300).optional(),
    }),
    notes: z.array(importNote).min(1).max(10000),
  })
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    file.notes.forEach((n, i) => {
      if (seen.has(n.externalId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['notes', i, 'externalId'],
          message: `дубль externalId «${n.externalId}»`,
        });
      }
      seen.add(n.externalId);
    });
  });
export type ImportFile = z.infer<typeof importFile>;

export interface ParseResult {
  ok: boolean;
  data?: ImportFile;
  errors: string[];
}

/** Parses raw JSON text and returns human-readable errors (max 10). */
export function parseImport(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (e) {
    return { ok: false, errors: [`Это не JSON: ${(e as Error).message}`] };
  }
  const res = importFile.safeParse(json);
  if (res.success) return { ok: true, data: res.data, errors: [] };
  const errors = res.error.issues
    .slice(0, 10)
    .map((i) => `${i.path.length ? i.path.join('.') : '(файл)'}: ${i.message}`);
  if (res.error.issues.length > 10) errors.push(`…и ещё ${res.error.issues.length - 10} ошибок`);
  return { ok: false, errors };
}
