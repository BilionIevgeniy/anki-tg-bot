import type { ReactNode } from 'react';
import type { CardDto } from './api';

interface Vocab {
  lemma: string;
  article?: 'der' | 'die' | 'das';
  plural?: string;
  translation: string;
  hint?: string;
  example?: string;
  exampleTranslation?: string;
  praeteritum?: string;
  perfekt?: string;
  rektion?: string;
  register?: 'umgs' | 'neutral' | 'formell';
  falseFriend?: string;
  note?: string;
}

interface Basic {
  front: string;
  back: string;
  extra?: string;
}

export const ARTICLE_CLASS: Record<string, string> = { der: 'der', die: 'die', das: 'das' };

/** `code`, ```blocks``` and **bold** — everything else is plain text (React escapes it). */
export function Rich({ text }: { text: string }): ReactNode {
  const parts = text.split(/```(?:[a-zA-Z0-9]+)?\n?([\s\S]*?)```/g);
  return parts.map((part, i) => {
    if (i % 2 === 1) return <pre key={i}>{part.replace(/\n$/, '')}</pre>;
    return part.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((t, j) => {
      if (t.startsWith('`') && t.endsWith('`')) return <code key={`${i}-${j}`}>{t.slice(1, -1)}</code>;
      if (t.startsWith('**') && t.endsWith('**')) return <b key={`${i}-${j}`}>{t.slice(2, -2)}</b>;
      return <span key={`${i}-${j}`}>{t}</span>;
    });
  });
}

function GermanWord({ f, big }: { f: Vocab; big?: boolean }) {
  return (
    <div className={big ? 'de-word big' : 'de-word'}>
      {f.article && <span className={`art ${ARTICLE_CLASS[f.article]}`}>{f.article} </span>}
      <span>{f.lemma}</span>
      {f.rektion && <span className="rektion"> {f.rektion}</span>}
    </div>
  );
}

function Grammar({ f }: { f: Vocab }) {
  const forms = [f.praeteritum, f.perfekt].filter(Boolean).join(' · ');
  return (
    <div className="grammar">
      {f.plural && <span className="pill">Pl. {f.plural.replace(/^die\s+/, '')}</span>}
      {forms && <span className="pill">{forms}</span>}
      {f.note && <span className="pill soft">{f.note}</span>}
      {f.register && f.register !== 'neutral' && (
        <span className="pill warn">{f.register === 'umgs' ? 'umgangssprachlich' : 'formell'}</span>
      )}
    </div>
  );
}

/** The question side. */
export function Front({ card }: { card: CardDto }) {
  if (card.note.type === 'basic') {
    const f = card.note.fields as unknown as Basic;
    return (
      <div className="face-body">
        <div className="question">
          <Rich text={card.template === 'rev' ? f.back : f.front} />
        </div>
      </div>
    );
  }
  const f = card.note.fields as unknown as Vocab;
  if (card.template === 'article') {
    return (
      <div className="face-body">
        <div className="kicker">Какой артикль?</div>
        <div className="de-word big">
          <span className="blank">___</span> {f.lemma}
        </div>
        <div className="hint">{f.translation}</div>
      </div>
    );
  }
  if (card.template === 'de_ru') {
    return (
      <div className="face-body">
        <GermanWord f={f} big />
        {f.example && <div className="example de">{f.example}</div>}
      </div>
    );
  }
  // ru_de — like Noji: only Russian on the front
  return (
    <div className="face-body">
      <div className="ru-word">{f.translation}</div>
      {f.hint && <div className="hint">({f.hint})</div>}
      {f.exampleTranslation && <div className="example">— {f.exampleTranslation}</div>}
    </div>
  );
}

/** The answer side (shown under a divider after the question). */
export function Back({ card, articleVerdict }: { card: CardDto; articleVerdict?: { ok: boolean; picked: string } }) {
  if (card.note.type === 'basic') {
    const f = card.note.fields as unknown as Basic;
    return (
      <div className="face-body answer">
        <div className="answer-text">
          <Rich text={card.template === 'rev' ? f.front : f.back} />
        </div>
        {f.extra && (
          <details className="extra">
            <summary>Подробнее</summary>
            <Rich text={f.extra} />
          </details>
        )}
      </div>
    );
  }
  const f = card.note.fields as unknown as Vocab;
  return (
    <div className="face-body answer">
      {articleVerdict && (
        <div className={articleVerdict.ok ? 'verdict ok' : 'verdict bad'}>
          {articleVerdict.ok ? '✓ Верно' : `✗ Ты выбрал «${articleVerdict.picked}»`}
        </div>
      )}
      {card.template === 'de_ru' ? <div className="ru-word">{f.translation}</div> : <GermanWord f={f} big />}
      <Grammar f={f} />
      {f.example && <div className="example de">{f.example}</div>}
      {card.template !== 'ru_de' && f.exampleTranslation && <div className="example">{f.exampleTranslation}</div>}
      {f.falseFriend && <div className="false-friend">⚠️ {f.falseFriend}</div>}
    </div>
  );
}
