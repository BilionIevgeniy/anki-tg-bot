Ты — независимый лингвист-германист (C2), преподаёшь немецкий русскоязычным IT-специалистам в Германии. Ты НЕ участвовал в создании карточек. Проверь и исправь пачку флэш-карточек.

Прочитай правила: /home/claude/anki-tg-bot/docs/CARD_RULES.md (особенно 2–5 и 4a) и формат /home/claude/anki-tg-bot/docs/IMPORT_FORMAT.md.

Файл для проверки: /home/claude/anki-tg-bot/sources/noji/work/{B}_notes.json (поля notes[].fields: lemma, article, plural, pos, translation, hint, praeteritum, perfekt, rektion, note, register, example, exampleTranslation, falseFriend). Исходник Noji для справки: /home/claude/anki-tg-bot/sources/noji/work/{B}_src.json.

Проверь КАЖДУЮ запись и ИСПРАВЬ прямо в файле:
1. Грамматика: артикль, plural/nur Sg., Präteritum, Perfekt с правильным hat/ist, du-форма (только при смене корневой гласной), управление и падеж.
2. Пример: грамматически безупречен, естественен (так реально говорят в Германии в 2026 — офис/IT/быт/ведомства), содержит саму лемму в нужном значении, B2–C1, не штамп, факты верны для Германии.
3. translation — точный и короткий; exampleTranslation — точный по смыслу и естественный по-русски.
4. Атомарность (одно значение), hint там, где у русского перевода есть немецкий «конкурент» (подход → Ansatz и т.п.), register только в поле register (formell для амтсдойча).
5. Явные дубли одного слова в одном значении внутри файла — оставь одну запись (у удаляемой запиши её _src в _dropped с reason "дубль <externalId>", если её _src не "__none__" и больше нигде не встречается).

НЕ МЕНЯЙ: externalId, _src, deck, теги "noji". Не трогай другие файлы, не делай коммитов.

После правок обязательно прогони валидатор до 0 ошибок:
cd /home/claude/anki-tg-bot && npx ts-node --transpile-only scripts/noji/validate-batch.ts /home/claude/anki-tg-bot/sources/noji/work/{B}_src.json /home/claude/anki-tg-bot/sources/noji/work/{B}_notes.json

Ответ (до 150 слов): сколько записей проверено, сколько исправлено, критичные ошибки (2–5 примеров «было → стало»), вывод валидатора.


ВАЖНО про _dropped: если группа выброшена потому, что слово уже есть в колоде (decks/) или в другой записи, в reason ОБЯЗАТЕЛЬНО укажи его externalId в формате «дубль de:xxx» — по нему переносится прогресс изучения из Noji.
