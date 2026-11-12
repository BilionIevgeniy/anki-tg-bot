/**
 * Which cards a note produces, and how each card side is rendered (Telegram HTML).
 * Pure functions — easy to test and to extend with new note types.
 */
import type { BasicFields, VocabDeFields } from '../import/contract';

export type Template = 'de_ru' | 'ru_de' | 'article' | 'fwd' | 'rev';

export interface NoteLike {
  type: string;
  fields: Record<string, unknown>;
  /** For basic notes: whether the reverse card exists. */
  reverse?: boolean;
}

export function templatesFor(note: NoteLike): Template[] {
  if (note.type === 'vocab_de') {
    const f = note.fields as VocabDeFields;
    const list: Template[] = ['de_ru', 'ru_de'];
    if (f.pos === 'noun' && f.article) list.push('article');
    return list;
  }
  if (note.type === 'basic') {
    const reverse = note.reverse ?? note.fields.reverse === true;
    return reverse ? ['fwd', 'rev'] : ['fwd'];
  }
  return [];
}

export const TEMPLATE_LABEL: Record<Template, string> = {
  de_ru: 'DE → RU',
  ru_de: 'RU → DE',
  article: 'Артикль',
  fwd: 'Вопрос → ответ',
  rev: 'Ответ → вопрос',
};

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Light markup for basic cards: `code`, ```blocks```, **bold**. Everything else is escaped. */
export function richText(s: string): string {
  const parts = s.split(/```(?:[a-zA-Z0-9]+)?\n?([\s\S]*?)```/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return `<pre>${escapeHtml(part.replace(/\n$/, ''))}</pre>`;
      return escapeHtml(part)
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    })
    .join('');
}

export function germanWord(f: Pick<VocabDeFields, 'article' | 'lemma'>): string {
  return f.article ? `${f.article} ${f.lemma}` : f.lemma;
}

/** "<b>das Gerät</b>", "<b>umgehen</b> <i>mit + Dat.</i>" */
function headHtml(f: VocabDeFields): string {
  const rek = f.rektion ? ` <i>${escapeHtml(f.rektion)}</i>` : '';
  return `<b>${escapeHtml(germanWord(f))}</b>${rek}`;
}

function vocabDetails(f: VocabDeFields, withExampleTranslation = true): string {
  const lines: string[] = [];
  if (f.plural) lines.push(`Pl.: ${escapeHtml(f.plural)}`);
  if (f.praeteritum || f.perfekt) {
    lines.push(
      `Formen: ${[f.praeteritum, f.perfekt]
        .filter(Boolean)
        .map((x) => escapeHtml(x!))
        .join(' · ')}`,
    );
  }
  if (f.register && f.register !== 'neutral')
    lines.push(`<i>${f.register === 'umgs' ? 'umgangssprachlich' : 'formell'}</i>`);
  if (f.example) {
    lines.push('');
    lines.push(`<i>${escapeHtml(f.example)}</i>`);
    if (f.exampleTranslation && withExampleTranslation)
      lines.push(escapeHtml(f.exampleTranslation));
  }
  if (f.falseFriend) lines.push(`⚠️ ${escapeHtml(f.falseFriend)}`);
  if (f.note) lines.push(`📝 ${escapeHtml(f.note)}`);
  return lines.join('\n');
}

export function renderFront(note: NoteLike, template: Template): string {
  if (note.type === 'vocab_de') {
    const f = note.fields as VocabDeFields;
    switch (template) {
      case 'de_ru':
        return headHtml(f);
      case 'ru_de': {
        // like Noji: only Russian on the front — the word and the example sentence
        const hint = f.hint ? `\n<i>(${escapeHtml(f.hint)})</i>` : '';
        const ex = f.exampleTranslation ? `\n\n— ${escapeHtml(f.exampleTranslation)}` : '';
        return `<b>${escapeHtml(f.translation)}</b>${hint}${ex}`;
      }
      case 'article':
        return `Какой артикль?\n\n<b>___ ${escapeHtml(f.lemma)}</b>\n<i>${escapeHtml(f.translation)}</i>`;
      default:
        break;
    }
  }
  if (note.type === 'basic') {
    const f = note.fields as BasicFields;
    return template === 'rev' ? richText(f.back) : richText(f.front);
  }
  return '(неизвестный тип карточки)';
}

export function renderBack(note: NoteLike, template: Template): string {
  if (note.type === 'vocab_de') {
    const f = note.fields as VocabDeFields;
    if (template === 'ru_de') {
      // the Russian side is already visible above: German word, forms and the German example
      const details = vocabDetails(f, false);
      return details ? `${headHtml(f)}\n${details}` : headHtml(f);
    }
    const head = template === 'de_ru' ? `<b>${escapeHtml(f.translation)}</b>` : headHtml(f);
    const details = vocabDetails(f);
    return details ? `${head}\n${details}` : head;
  }
  if (note.type === 'basic') {
    const f = note.fields as BasicFields;
    const main = template === 'rev' ? richText(f.front) : richText(f.back);
    return f.extra ? `${main}\n\n<blockquote expandable>${richText(f.extra)}</blockquote>` : main;
  }
  return '';
}

/** Short one-line label of a note for lists ("das Gerät — прибор"). */
export function noteTitle(note: NoteLike): string {
  if (note.type === 'vocab_de') {
    const f = note.fields as VocabDeFields;
    return `${germanWord(f)} — ${f.translation}`;
  }
  const f = note.fields as BasicFields;
  return f.front.length > 60 ? `${f.front.slice(0, 57)}…` : f.front;
}

/** Telegram allows 4096 chars per message; keep a safety margin for headers and buttons. */
export function clampMessage(html: string, max = 3800): string {
  if (html.length <= max) return html;
  return `${html.slice(0, max)}…\n\n<i>(текст обрезан — карточку стоит разбить на несколько)</i>`;
}
