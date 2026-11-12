import { InlineKeyboard } from 'grammy';
import { ARTICLES } from '../import/contract';
import type { Deck } from '../db/schema';
import { formatHm } from '../srs/day';
import type { GradePreview } from '../srs/fsrs.core';
import { encode } from './callback-data';

export const GRADE_UI: Record<number, { emoji: string; name: string }> = {
  1: { emoji: '❌', name: 'Снова' },
  2: { emoji: '😐', name: 'Трудно' },
  3: { emoji: '✅', name: 'Хорошо' },
  4: { emoji: '🚀', name: 'Легко' },
};

function stopRow(kb: InlineKeyboard, undoLogId?: number, scope = 0): InlineKeyboard {
  if (undoLogId) kb.text('↩️ Отменить ответ', encode({ a: 'undo', logId: undoLogId, scope }));
  return kb.text('⏹ Стоп', encode({ a: 'stop' }));
}

export function frontKeyboard(
  card: { id: number; version: number; template: string },
  scope: number,
  undoLogId?: number,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (card.template === 'article') {
    ARTICLES.forEach((art, i) =>
      kb.text(
        art,
        encode({ a: 'art', cardId: card.id, choice: i + 1, version: card.version, scope }),
      ),
    );
  } else {
    kb.text(
      '👁 Показать ответ',
      encode({ a: 'show', cardId: card.id, version: card.version, scope }),
    );
  }
  kb.row();
  return stopRow(kb, undoLogId, scope);
}

export function gradeKeyboard(
  card: { id: number; version: number },
  previews: GradePreview[],
  scope: number,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  previews.forEach((p, i) => {
    const ui = GRADE_UI[p.grade]!;
    kb.text(
      `${ui.emoji} ${ui.name} · ${p.label}`,
      encode({ a: 'rate', cardId: card.id, rating: p.grade, version: card.version, scope }),
    );
    if (i % 2 === 1) kb.row();
  });
  return stopRow(kb);
}

export function learnButton(label: string, scope: number): InlineKeyboard {
  return new InlineKeyboard().text(label, encode({ a: 'learn', scope }));
}

export function deckMenuKeyboard(deck: Deck, dueTotal: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (!deck.isPaused)
    kb.text(`▶️ Учить (${dueTotal})`, encode({ a: 'learn', scope: deck.id })).row();
  kb.text('🆕 −5', encode({ a: 'deckSet', deckId: deck.id, field: 0, value: -5 }))
    .text(`🆕 ${deck.newPerDay}/день`, encode({ a: 'deck', deckId: deck.id }))
    .text('🆕 +5', encode({ a: 'deckSet', deckId: deck.id, field: 0, value: 5 }))
    .row()
    .text(
      deck.isPaused ? '▶️ Снять с паузы' : '⏸ Пауза',
      encode({ a: 'deckSet', deckId: deck.id, field: 1, value: 0 }),
    )
    .text(
      deck.notifyEnabled ? `🔔 ${formatHm(deck.notifyHour, deck.notifyMinute)}` : '🔕 Уведомления',
      encode({ a: 'notify', deckId: deck.id }),
    )
    .row()
    .text(
      deck.enabledTemplates.includes('de_ru') ? '🔁 DE→RU: вкл' : '🔁 DE→RU: выкл',
      encode({ a: 'deckSet', deckId: deck.id, field: 2, value: 0 }),
    )
    .row()
    .text('📤 Экспорт', encode({ a: 'export', deckId: deck.id }))
    .text('⬅️ Все колоды', encode({ a: 'decks' }));
  return kb;
}

const PRESETS: [number, number][] = [
  [7, 0],
  [9, 0],
  [12, 0],
  [18, 0],
  [20, 0],
  [21, 30],
];
const MIN_DUE = [1, 5, 20, 50];

export function notifyKeyboard(deck: Deck): InlineKeyboard {
  const id = deck.id;
  const kb = new InlineKeyboard()
    .text(
      deck.notifyEnabled ? '🔕 Выключить' : '🔔 Включить',
      encode({ a: 'nSet', deckId: id, field: 0, value: deck.notifyEnabled ? 0 : 1 }),
    )
    .row()
    .text('−1ч', encode({ a: 'nSet', deckId: id, field: 1, value: -60 }))
    .text('−15м', encode({ a: 'nSet', deckId: id, field: 1, value: -15 }))
    .text(formatHm(deck.notifyHour, deck.notifyMinute), encode({ a: 'notify', deckId: id }))
    .text('+15м', encode({ a: 'nSet', deckId: id, field: 1, value: 15 }))
    .text('+1ч', encode({ a: 'nSet', deckId: id, field: 1, value: 60 }))
    .row();
  PRESETS.forEach(([h, m], i) => {
    kb.text(formatHm(h, m), encode({ a: 'nSet', deckId: id, field: 2, value: h * 60 + m }));
    if (i === 2) kb.row();
  });
  kb.row();
  MIN_DUE.forEach((n) =>
    kb.text(
      `${deck.notifyMinDue === n ? '• ' : ''}≥${n}`,
      encode({ a: 'nSet', deckId: id, field: 3, value: n }),
    ),
  );
  return kb
    .row()
    .text('⬅️ К колоде', encode({ a: 'deck', deckId: id }))
    .text('📋 Все уведомления', encode({ a: 'notifyList' }));
}

export function reminderKeyboard(deck: Deck, appUrl?: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (appUrl) kb.webApp('📱 Учить в приложении', appUrl).row();
  return kb
    .text('▶️ Учить', encode({ a: 'learn', scope: deck.id }))
    .text('💤 Через 3 ч', encode({ a: 'snooze', deckId: deck.id }))
    .row()
    .text('⚙️ Настроить', encode({ a: 'notify', deckId: deck.id }))
    .text('🔕 Выключить', encode({ a: 'nSet', deckId: deck.id, field: 0, value: 0 }));
}

export function importConfirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Импортировать', encode({ a: 'impOk' }))
    .text('❌ Отмена', encode({ a: 'impNo' }));
}
