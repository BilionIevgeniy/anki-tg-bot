/**
 * Compact, stateless callback_data (Telegram limit: 64 bytes).
 * Format: "<action>:<arg1>:<arg2>..." with numeric args.
 */

export type Callback =
  /** Show the answer side. scope: 0 = all decks, otherwise deckId */
  | { a: 'show'; cardId: number; version: number; scope: number }
  /** Rate a card 1..4 */
  | { a: 'rate'; cardId: number; rating: number; version: number; scope: number }
  /** Article quiz: 1 der, 2 die, 3 das */
  | { a: 'art'; cardId: number; choice: number; version: number; scope: number }
  | { a: 'undo'; logId: number; scope: number }
  | { a: 'learn'; scope: number }
  | { a: 'stop' }
  | { a: 'deck'; deckId: number }
  | { a: 'decks' }
  | { a: 'deckSet'; deckId: number; field: DeckSetting; value: number }
  | { a: 'notify'; deckId: number }
  | { a: 'notifyList' }
  | { a: 'nSet'; deckId: number; field: NotifySetting; value: number }
  | { a: 'snooze'; deckId: number }
  | { a: 'impOk' }
  | { a: 'impNo' }
  | { a: 'unleech'; cardId: number }
  | { a: 'export'; deckId: number }
  /** "➕ 10 more new cards today" */
  | { a: 'more'; scope: number };

/** 0 newPerDay (value = delta), 1 pause toggle, 2 toggle the DE→RU direction */
export type DeckSetting = 0 | 1 | 2;
/** 0 enabled (0/1), 1 shift minutes (delta), 2 set time (minutes of day), 3 minDue */
export type NotifySetting = 0 | 1 | 2 | 3;

const CODES = {
  show: 's',
  rate: 'r',
  art: 'a',
  undo: 'u',
  learn: 'l',
  stop: 'x',
  deck: 'd',
  decks: 'D',
  deckSet: 'ds',
  notify: 'n',
  notifyList: 'N',
  nSet: 'ns',
  snooze: 'z',
  impOk: 'iy',
  impNo: 'in',
  unleech: 'ul',
  export: 'e',
  more: 'm',
} as const satisfies Record<Callback['a'], string>;

export function encode(cb: Callback): string {
  const code = CODES[cb.a];
  let args: number[];
  switch (cb.a) {
    case 'show':
      args = [cb.cardId, cb.version, cb.scope];
      break;
    case 'rate':
      args = [cb.cardId, cb.rating, cb.version, cb.scope];
      break;
    case 'art':
      args = [cb.cardId, cb.choice, cb.version, cb.scope];
      break;
    case 'undo':
      args = [cb.logId, cb.scope];
      break;
    case 'learn':
    case 'more':
      args = [cb.scope];
      break;
    case 'deck':
    case 'notify':
    case 'snooze':
    case 'export':
      args = [cb.deckId];
      break;
    case 'deckSet':
    case 'nSet':
      args = [cb.deckId, cb.field, cb.value];
      break;
    case 'unleech':
      args = [cb.cardId];
      break;
    default:
      args = [];
  }
  const out = [code, ...args].join(':');
  if (Buffer.byteLength(out) > 64) throw new Error(`callback_data too long: ${out}`);
  return out;
}

export function decode(data: string): Callback | null {
  const [code, ...rest] = data.split(':');
  const n = rest.map(Number);
  if (n.some((x) => !Number.isFinite(x) || !Number.isInteger(x))) return null;
  const [a = NaN, b = NaN, c = NaN, d = NaN] = n;
  const need = (k: number) => n.length === k;
  switch (code) {
    case 's':
      return need(3) ? { a: 'show', cardId: a, version: b, scope: c } : null;
    case 'r':
      return need(4) && b >= 1 && b <= 4
        ? { a: 'rate', cardId: a, rating: b, version: c, scope: d }
        : null;
    case 'a':
      return need(4) && b >= 1 && b <= 3
        ? { a: 'art', cardId: a, choice: b, version: c, scope: d }
        : null;
    case 'u':
      return need(2) ? { a: 'undo', logId: a, scope: b } : null;
    case 'l':
      return need(1) ? { a: 'learn', scope: a } : null;
    case 'x':
      return { a: 'stop' };
    case 'd':
      return need(1) ? { a: 'deck', deckId: a } : null;
    case 'D':
      return { a: 'decks' };
    case 'ds':
      return need(3) && (b === 0 || b === 1 || b === 2)
        ? { a: 'deckSet', deckId: a, field: b, value: c }
        : null;
    case 'n':
      return need(1) ? { a: 'notify', deckId: a } : null;
    case 'N':
      return { a: 'notifyList' };
    case 'ns':
      return need(3) && b >= 0 && b <= 3
        ? { a: 'nSet', deckId: a, field: b as NotifySetting, value: c }
        : null;
    case 'z':
      return need(1) ? { a: 'snooze', deckId: a } : null;
    case 'iy':
      return { a: 'impOk' };
    case 'in':
      return { a: 'impNo' };
    case 'ul':
      return need(1) ? { a: 'unleech', cardId: a } : null;
    case 'e':
      return need(1) ? { a: 'export', deckId: a } : null;
    case 'm':
      return need(1) ? { a: 'more', scope: a } : null;
    default:
      return null;
  }
}
