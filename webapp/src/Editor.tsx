import { useState } from 'react';
import type { CardDto } from './api';

type Kind = 'text' | 'area' | 'select';
interface FieldDef {
  key: string;
  label: string;
  kind: Kind;
  required?: boolean;
  options?: { value: string; label: string }[];
  placeholder?: string;
}

const VOCAB: FieldDef[] = [
  {
    key: 'article',
    label: 'Артикль',
    kind: 'select',
    options: [
      { value: '', label: '—' },
      { value: 'der', label: 'der' },
      { value: 'die', label: 'die' },
      { value: 'das', label: 'das' },
    ],
  },
  { key: 'lemma', label: 'Слово (без артикля)', kind: 'text', required: true },
  { key: 'plural', label: 'Множественное число', kind: 'text', placeholder: 'die Geräte / nur Sg.' },
  { key: 'translation', label: 'Перевод', kind: 'text', required: true },
  { key: 'hint', label: 'Подсказка (видна на лицевой стороне)', kind: 'text' },
  { key: 'example', label: 'Пример (DE)', kind: 'area' },
  { key: 'exampleTranslation', label: 'Перевод примера (RU)', kind: 'area' },
  { key: 'praeteritum', label: 'Präteritum', kind: 'text' },
  { key: 'perfekt', label: 'Partizip II / Perfekt', kind: 'text', placeholder: 'hat gekümmert' },
  { key: 'rektion', label: 'Управление', kind: 'text', placeholder: 'auf + Akk.' },
  {
    key: 'pos',
    label: 'Часть речи',
    kind: 'select',
    options: [
      { value: 'noun', label: 'существительное' },
      { value: 'verb', label: 'глагол' },
      { value: 'adj', label: 'прилагательное' },
      { value: 'adv', label: 'наречие' },
      { value: 'phrase', label: 'фраза' },
      { value: 'other', label: 'другое' },
    ],
  },
  {
    key: 'register',
    label: 'Стиль',
    kind: 'select',
    options: [
      { value: '', label: '—' },
      { value: 'umgs', label: 'разговорный (umgs.)' },
      { value: 'neutral', label: 'нейтральный' },
      { value: 'formell', label: 'формальный' },
    ],
  },
  { key: 'falseFriend', label: 'Ложный друг', kind: 'text' },
  { key: 'note', label: 'Заметка', kind: 'area' },
];

const BASIC: FieldDef[] = [
  { key: 'front', label: 'Вопрос', kind: 'area', required: true },
  { key: 'back', label: 'Ответ', kind: 'area', required: true },
  { key: 'extra', label: 'Дополнение', kind: 'area' },
];

interface Props {
  card: CardDto;
  busy: boolean;
  error: string | null;
  onSave: (fields: Record<string, string | null>) => void;
  onDelete: () => void;
  onCancel: () => void;
}

/** ✏️ Full-screen form to fix a word (or an interview card) without leaving the session. */
export function Editor({ card, busy, error, onSave, onDelete, onCancel }: Props) {
  const defs = card.note.type === 'basic' ? BASIC : VOCAB;
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      defs.map((d) => {
        const v = card.note.fields[d.key];
        return [d.key, typeof v === 'string' ? v : d.key === 'pos' ? 'other' : ''];
      }),
    ),
  );
  const missing = defs.filter((d) => d.required && !values[d.key]?.trim());

  const save = () => {
    if (missing.length || busy) return;
    // empty field = remove the value
    onSave(Object.fromEntries(defs.map((d) => [d.key, values[d.key]?.trim() ? values[d.key]! : null])));
  };

  return (
    <div className="screen editor">
      <header className="top">
        <button className="icon" onClick={onCancel} disabled={busy} aria-label="Отмена">
          ✕
        </button>
        <div className="counter">✏️ Редактирование</div>
        <span className="icon-spacer" />
      </header>

      <main className="editor-body">
        {defs.map((d) => (
          <label key={d.key} className="field">
            <span className="field-label">
              {d.label}
              {d.required && <i> *</i>}
            </span>
            {d.kind === 'select' ? (
              <select
                value={values[d.key]}
                onChange={(e) => setValues((v) => ({ ...v, [d.key]: e.target.value }))}
              >
                {d.options!.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : d.kind === 'area' ? (
              <textarea
                rows={3}
                value={values[d.key]}
                placeholder={d.placeholder}
                onChange={(e) => setValues((v) => ({ ...v, [d.key]: e.target.value }))}
              />
            ) : (
              <input
                value={values[d.key]}
                placeholder={d.placeholder}
                onChange={(e) => setValues((v) => ({ ...v, [d.key]: e.target.value }))}
              />
            )}
          </label>
        ))}
        {error && <p className="editor-error">{error}</p>}
        <button className="btn danger wide" onClick={onDelete} disabled={busy}>
          🗑 Удалить {card.note.type === 'basic' ? 'карточку' : 'слово'}
        </button>
        <p className="muted small">
          Прогресс заучивания при правке сохраняется. Удалённое слово уходит из очереди и счётчика, и
          обновление колод его не вернёт.
        </p>
      </main>

      <footer className="actions">
        <div className="row two">
          <button className="btn ghost" onClick={onCancel} disabled={busy}>
            Отмена
          </button>
          <button className="btn primary" onClick={save} disabled={busy || missing.length > 0}>
            Сохранить
          </button>
        </div>
      </footer>
    </div>
  );
}
