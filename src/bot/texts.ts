/** All user-facing texts in one place (Russian UI). HTML parse mode. */
import type { Deck, User } from '../db/schema';
import type { ImportReport } from '../import/import.service';
import { formatHm } from '../srs/day';
import type { Counts } from '../srs/queue.service';
import type { UserStats } from '../stats/stats.service';
import { escapeHtml } from '../cards/templates';

export const COMMANDS = [
  { command: 'learn', description: '▶️ Учить всё, что ждёт сегодня' },
  { command: 'today', description: '📅 Что на сегодня по колодам' },
  { command: 'decks', description: '📚 Колоды и их настройки' },
  { command: 'notify', description: '🔔 Напоминания для каждой колоды' },
  { command: 'import', description: '📥 Загрузить карточки (JSON)' },
  { command: 'export', description: '📤 Выгрузить колоды с прогрессом' },
  { command: 'stats', description: '📊 Статистика' },
  { command: 'leeches', description: '🩸 Трудные карточки («пиявки»)' },
  { command: 'timezone', description: '🌍 Часовой пояс' },
  { command: 'help', description: '❓ Как пользоваться' },
] as const;

export function startText(user: User): string {
  const name = user.firstName ? `, ${escapeHtml(user.firstName)}` : '';
  return [
    `Привет${name}! 👋`,
    '',
    'Я тренажёр памяти по методу интервального повторения (как Anki, алгоритм <b>FSRS</b>).',
    'Показываю карточку → ты вспоминаешь → открываешь ответ → честно оцениваешь.',
    'Чем лучше помнишь, тем реже я её покажу.',
    '',
    '<b>С чего начать</b>',
    '1. Пришли мне файл <code>.json</code> с карточками — /import расскажет формат.',
    '2. Нажми /learn.',
    '3. Включи напоминание для колоды — /notify.',
    '',
    'Полная инструкция — /help',
  ].join('\n');
}

export const HELP_TEXT = [
  '<b>❓ Как пользоваться</b>',
  '',
  '<b>Учёба</b>',
  '/learn — все колоды подряд. Сначала то, что сейчас в обучении, потом повторения, потом новые (в пределах дневного лимита).',
  '/today — сколько ждёт в каждой колоде, можно запустить одну колоду.',
  '',
  '<b>Кнопки оценки</b>',
  '❌ <b>Снова</b> — не вспомнил. Карточка вернётся через минуту.',
  '😐 <b>Трудно</b> — вспомнил с трудом.',
  '✅ <b>Хорошо</b> — вспомнил нормально. Жми её чаще всего.',
  '🚀 <b>Легко</b> — знаю отлично, можно надолго.',
  'На кнопке написано, через сколько карточка вернётся.',
  '↩️ под следующей карточкой отменяет последний ответ. Вся сессия идёт в одном сообщении — история не копится.',
  '',
  '<b>Немецкие слова</b>',
  'Карточка как в Noji: на лицевой стороне русское слово и пример, на обороте немецкое слово, формы и немецкий пример. У существительных ещё «Какой артикль?» (кнопки der/die/das, проверяю сам). Обратное направление DE→RU можно включить в /decks.',
  '',
  '<b>Колоды</b> — /decks',
  'Лимит новых в день, пауза, напоминание, экспорт. Колод сколько угодно: немецкий, вопросы к собеседованию, что захочешь.',
  '',
  '<b>Напоминания</b> — /notify',
  'Для каждой колоды своё время и порог («напомни, если ждут ≥ 20»). Одно сообщение в день, 💤 откладывает на 3 часа. Пропуск дня ничего не обнуляет.',
  '',
  '<b>Импорт</b> — /import',
  'Пришли файл <code>.json</code> (контракт v1). Я покажу, что изменится, и спрошу подтверждение. Повторный импорт обновляет тексты, а <b>прогресс не трогает никогда</b>.',
  '',
  '<b>Ещё</b>',
  '/export — бэкап колод в том же формате (с прогрессом)',
  '/stats — статистика без стриков и давления',
  '/leeches — карточки, которые никак не запоминаются (8 ошибок). Их лучше переформулировать.',
  '/timezone Europe/Berlin — часовой пояс (новый день начинается в 4:00)',
  '/cancel — отменить текущее действие',
].join('\n');

export const IMPORT_HELP = [
  '<b>📥 Импорт карточек</b>',
  '',
  'Пришли мне файл <code>.json</code> (можно просто переслать). Короткий JSON можно вставить текстом.',
  '',
  'Минимальный пример:',
  '<pre>{',
  '  "schemaVersion": 1,',
  '  "deck": { "key": "de-b2", "name": "Deutsch B2" },',
  '  "notes": [',
  '    { "externalId": "de:geraet", "type": "vocab_de",',
  '      "fields": { "article": "das", "lemma": "Gerät",',
  '        "plural": "die Geräte", "pos": "noun",',
  '        "translation": "прибор, устройство",',
  '        "example": "Das Gerät ist kaputt." } },',
  '    { "externalId": "iv:closure", "type": "basic",',
  '      "fields": { "front": "Что такое замыкание?",',
  '        "back": "Функция + её лексическое окружение" } }',
  '  ]',
  '}</pre>',
  '',
  '• <code>deck.key</code> — постоянный id колоды (латиница). Тот же key = та же колода.',
  '• <code>externalId</code> — постоянный id карточки. По нему обновляю без потери прогресса.',
  '• Типы: <code>vocab_de</code> (немецкое слово) и <code>basic</code> (вопрос/ответ, можно <code>"reverse": true</code>).',
  '',
  'Полный формат — <code>docs/IMPORT_FORMAT.md</code> в репозитории. Жду файл… (/cancel — отмена)',
].join('\n');

export function countsLine(c: Counts): string {
  return `🆕 ${c.new} · 📖 ${c.learning} · 🔁 ${c.review}`;
}

export function importReportText(r: ImportReport, dry: boolean): string {
  const lines = [
    dry ? '<b>📥 Проверка файла — всё в порядке</b>' : '<b>✅ Импорт завершён</b>',
    '',
    `Колода: <b>${escapeHtml(r.deckName)}</b> (<code>${escapeHtml(r.deckKey)}</code>)${r.deckExists ? '' : ' — новая'}`,
    `➕ Новых записей: ${r.created} (карточек: ${r.cardsCreated})`,
    `✏️ Обновится: ${r.updated}`,
    `⏸ Без изменений: ${r.unchanged}`,
  ];
  if (r.withProgress) lines.push(`🧠 С перенесённым прогрессом: ${r.withProgress}`);
  if (dry) lines.push('', 'Прогресс существующих карточек не изменится. Импортировать?');
  return lines.join('\n');
}

export function deckMenuText(
  deck: Deck,
  c: Counts,
  total: number,
  suspended: number,
  tz: string,
): string {
  return [
    `<b>📚 ${escapeHtml(deck.name)}</b>${deck.isPaused ? ' ⏸ на паузе' : ''}`,
    deck.description ? `<i>${escapeHtml(deck.description)}</i>` : '',
    '',
    `Сегодня: ${countsLine(c)}`,
    `Карточек всего: ${total}${suspended ? ` (отложено: ${suspended})` : ''}`,
    `Новых в день: ${deck.newPerDay} · Повторений в день до ${deck.reviewsPerDay}`,
    `Карточки: ${templatesText(deck.enabledTemplates)}`,
    `Напоминание: ${deck.notifyEnabled ? `🔔 ${formatHm(deck.notifyHour, deck.notifyMinute)} (${escapeHtml(tz)}), если ждут ≥ ${deck.notifyMinDue}` : '🔕 выключено'}`,
  ]
    .filter((l, i) => l !== '' || i === 2)
    .join('\n');
}

function templatesText(enabled: string[]): string {
  const names: Record<string, string> = {
    ru_de: 'RU→DE',
    article: 'артикль',
    de_ru: 'DE→RU',
    fwd: 'вопрос→ответ',
    rev: 'ответ→вопрос',
  };
  return ['ru_de', 'article', 'de_ru', 'fwd', 'rev']
    .filter((t) => enabled.includes(t))
    .map((t) => names[t])
    .join(', ');
}

export function notifyText(deck: Deck, tz: string): string {
  return [
    `<b>🔔 Напоминания · ${escapeHtml(deck.name)}</b>`,
    '',
    `Статус: ${deck.notifyEnabled ? '✅ включены' : '❌ выключены'}`,
    `Время: <b>${formatHm(deck.notifyHour, deck.notifyMinute)}</b> (${escapeHtml(tz)})`,
    `Напоминать, если ждут ≥ <b>${deck.notifyMinDue}</b> карточек`,
    '',
    '<i>Не чаще раза в день. Если в это время ничего не ждёт, напомню позже, когда появятся карточки.</i>',
  ].join('\n');
}

export function statsText(s: UserStats): string {
  const pct = s.retention30d === null ? '—' : `${Math.round(s.retention30d * 100)}%`;
  return [
    '<b>📊 Статистика</b>',
    '',
    `Сегодня ответов: <b>${s.reviewedToday}</b>`,
    `Активных дней за последние 7: <b>${s.activeDaysLast7}</b>`,
    `Вспоминаешь при повторении (30 дн.): <b>${pct}</b>`,
    '',
    `🧠 В долгой памяти (интервал ≥ 21 дн.): <b>${s.mature}</b>`,
    `🌱 Молодые: ${s.young}`,
    `📖 В обучении: ${s.learning}`,
    `🆕 Ещё не начаты: ${s.fresh}`,
    s.leeches ? `🩸 Пиявки: ${s.leeches} — /leeches` : '',
    '',
    `Всего карточек: ${s.total}`,
  ]
    .filter((l, i, arr) => l !== '' || (arr[i - 1] ?? '') !== '')
    .join('\n');
}
