# Import format v1

The bot imports a single JSON file per deck. The validator lives in [`src/import/contract.ts`](../src/import/contract.ts) (zod); this document mirrors it.

```jsonc
{
  "schemaVersion": 1,
  "deck": {
    "key": "de-b2",            // stable id of the deck: a-z 0-9 - _ ; same key = same deck
    "name": "Deutsch B2",      // display name (can change between imports)
    "description": "optional"
  },
  "notes": [ /* 1 … 10 000 notes */ ]
}
```

## Rules that make re-imports safe

| Rule | Why |
|---|---|
| `externalId` is **stable** and unique within the deck | The bot upserts by `(deck.key, externalId)`. Never derive it from the translation or example text. Recommended: `de:<lemma>` (`de:gerät`, `de:sich-kümmern-um`); for homonyms add a suffix: `de:bank-1`, `de:bank-2`. |
| Re-import changes **content only** | Memory state (intervals, lapses) of existing cards is never touched. |
| Missing notes are **not deleted** | Removing a word from the file does not remove it from the bot. |
| `srs` is applied **only when a card is created** | Use it to migrate progress (Noji/Anki); it is ignored for existing cards. |
| Every import starts with a dry run | The bot shows "new / updated / unchanged" and asks for ✅. |

## Note type `vocab_de` (German word)

Produces cards: `de_ru` (DE → RU), `ru_de` (RU → DE) and, for nouns with an article, `article` (der/die/das quiz, auto-graded).

| Field | Required | Example |
|---|---|---|
| `lemma` | ✅ | `Gerät`, `ausführen`, `sich kümmern` — **without** the article |
| `article` | nouns | `der` / `die` / `das` |
| `plural` | nouns | `die Geräte`, or `nur Sg.` |
| `pos` | ✅ | `noun` `verb` `adj` `adv` `phrase` `other` |
| `translation` | ✅ | `прибор, устройство` |
| `hint` | | context shown on the RU→DE side so the answer is unambiguous: `техника` |
| `praeteritum` | verbs | `führte aus` |
| `perfekt` | verbs | `hat ausgeführt` (with hat/ist) |
| `rektion` | | `auf + Akk.` |
| `example` | recommended | one natural B2–C1 sentence |
| `exampleTranslation` | recommended | its translation |
| `register` | | `umgs` / `neutral` / `formell` |
| `falseFriend` | | `≠ рус. «фамилия»` |
| `note` | | free text, e.g. the du-form `du führst aus` |

```json
{
  "externalId": "de:ausführen",
  "type": "vocab_de",
  "fields": {
    "lemma": "ausführen",
    "pos": "verb",
    "translation": "выполнять, запускать (код)",
    "praeteritum": "führte aus",
    "perfekt": "hat ausgeführt",
    "note": "du führst aus",
    "example": "Wir müssen dieses Skript in der Konsole ausführen.",
    "exampleTranslation": "Нам нужно запустить этот скрипт в консоли."
  },
  "tags": ["it", "verb"]
}
```

## Note type `basic` (any question/answer)

Produces `fwd` (front → back) and, with `"reverse": true`, `rev` (back → front).

| Field | Required | Notes |
|---|---|---|
| `front` | ✅ | the question |
| `back` | ✅ | the answer — keep it short (≤ ~300 chars) |
| `extra` | | details, shown collapsed under the answer |

Light markup in all three: `` `code` ``, ```` ```code blocks``` ````, `**bold**`.

```json
{
  "externalId": "iv:js-closure",
  "type": "basic",
  "fields": {
    "front": "Что такое замыкание (closure)?",
    "back": "Функция + ссылка на лексическое окружение, в котором она создана.",
    "extra": "```js\nconst counter = () => { let n = 0; return () => ++n; };\n```"
  },
  "tags": ["interview", "js", "MUST"]
}
```

## Optional `srs` — migrate progress

Keys are card templates (`de_ru`, `ru_de`, `article`, `fwd`, `rev`):

```json
"srs": {
  "de_ru": {
    "state": "review",
    "due": "2026-11-17T00:00:00Z",
    "stability": 12.8,
    "difficulty": 6.5,
    "reps": 5,
    "lapses": 1,
    "scheduledDays": 13,
    "lastReview": "2026-11-04T00:00:00Z"
  }
}
```

`state` is one of `new`, `learning`, `review`, `relearning`. `/export` produces exactly this format, so an export is also a full backup.
