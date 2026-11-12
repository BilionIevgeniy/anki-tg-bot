import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type AnswerDto, api, ApiError, type MeDto, type NextDto } from './api';
import { Back, Front } from './CardContent';
import { haptic, tg } from './telegram';

const GRADES = [
  { grade: 1, name: 'Снова', cls: 'again' },
  { grade: 2, name: 'Трудно', cls: 'hard' },
  { grade: 3, name: 'Хорошо', cls: 'good' },
  { grade: 4, name: 'Легко', cls: 'easy' },
] as const;

const ARTICLES = ['der', 'die', 'das'] as const;

type Phase = 'question' | 'answer';

/** mm:ss until `target`; calls onZero once when it is reached. */
function useCountdown(target: string | null, onZero: () => void): string | null {
  const [now, setNow] = useState(() => Date.now());
  const cb = useRef(onZero);
  cb.current = onZero;
  useEffect(() => {
    if (!target) return;
    const end = new Date(target).getTime();
    const t = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= end) {
        clearInterval(t);
        cb.current();
      }
    }, 1000);
    return () => clearInterval(t);
  }, [target]);
  if (!target) return null;
  const s = Math.ceil(Math.max(0, new Date(target).getTime() - now) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function App() {
  const [me, setMe] = useState<MeDto | null>(null);
  const [scope, setScope] = useState(0);
  const [state, setState] = useState<NextDto | null>(null);
  const [phase, setPhase] = useState<Phase>('question');
  const [done, setDone] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [undoId, setUndoId] = useState<number | null>(null);
  const [verdict, setVerdict] = useState<{ ok: boolean; picked: string } | null>(null);
  const pending = useRef<NextDto | null>(null); // next card after an article answer

  const card = state?.card ?? null;

  const showToast = (text: string) => {
    setToast(text);
    setTimeout(() => setToast((t) => (t === text ? null : t)), 1800);
  };

  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.status === 401) setError('Открой приложение через бота в Telegram.');
    else if (e instanceof ApiError && e.status === 403) setError('Это приватный бот.');
    else setError('Нет связи с сервером. Попробуй ещё раз.');
  };

  const load = useCallback(async (s: number) => {
    setBusy(true);
    try {
      const [m, n] = await Promise.all([api.me(), api.next(s)]);
      setMe(m);
      setState(n);
      setPhase('question');
      setVerdict(null);
      setError(null);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(scope);
  }, [load, scope]);

  const advance = (res: AnswerDto | { ok: boolean; next: NextDto }) => {
    setState(res.next);
    setPhase('question');
    setVerdict(null);
  };

  const reveal = () => {
    if (!card || phase !== 'question' || card.template === 'article') return;
    haptic.tap();
    setPhase('answer');
  };

  const rate = async (grade: number) => {
    if (!card || busy) return;
    setBusy(true);
    grade === 1 ? haptic.bad() : haptic.tap();
    try {
      const res = await api.answer({ cardId: card.id, version: card.version, grade, scope });
      if (res.ok) {
        setDone((d) => d + 1);
        setUndoId(res.logId ?? null);
        const g = GRADES.find((x) => x.grade === grade)!;
        showToast(`${g.name} → снова через ${res.label}${res.leech ? ' · 🩸 отложена как трудная' : ''}`);
      }
      advance(res);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const pickArticle = async (art: string) => {
    if (!card || busy || phase !== 'question') return;
    const right = (card.note.fields as { article?: string }).article;
    const ok = art === right;
    ok ? haptic.good() : haptic.bad();
    setVerdict({ ok, picked: art });
    setPhase('answer');
    setBusy(true);
    try {
      const res = await api.answer({ cardId: card.id, version: card.version, grade: ok ? 3 : 1, scope });
      if (res.ok) {
        setDone((d) => d + 1);
        setUndoId(res.logId ?? null);
      }
      pending.current = res.next;
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const continueAfterArticle = () => {
    if (!pending.current) return;
    advance({ ok: true, next: pending.current });
    pending.current = null;
  };

  const undo = async () => {
    if (!undoId || busy) return;
    setBusy(true);
    try {
      const res = await api.undo(undoId, scope);
      if (res.ok) {
        setDone((d) => Math.max(0, d - 1));
        showToast('↩️ Ответ отменён');
      }
      setUndoId(null);
      pending.current = null;
      advance(res);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  // keyboard: Space = show, 1–4 = grades (handy on desktop Telegram)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        if (phase === 'question') reveal();
        else if (card?.template === 'article') continueAfterArticle();
      }
      if (phase === 'answer' && card?.template !== 'article' && ['1', '2', '3', '4'].includes(e.key)) {
        void rate(Number(e.key));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const countdown = useCountdown(card ? null : (state?.nextLearningDue ?? null), () => void load(scope));

  const total = done + (state?.counts.total ?? 0);
  const progress = total ? Math.min(100, (done / total) * 100) : 100;
  const previews = useMemo(() => new Map(card?.previews.map((p) => [p.grade, p.label])), [card]);

  if (error) {
    return (
      <div className="screen center">
        <div className="big-emoji">⚠️</div>
        <p>{error}</p>
        <button className="btn primary" onClick={() => void load(scope)}>
          Повторить
        </button>
      </div>
    );
  }

  if (!state) return <div className="screen center"><div className="spinner" /></div>;

  return (
    <div className="screen">
      <header className="top">
        <button className="icon" onClick={() => tg?.close()} aria-label="Закрыть">✕</button>
        <div className="counter">
          {card ? (
            <>
              <b>{done + 1}</b>/{total}
            </>
          ) : (
            `${done} ✓`
          )}
        </div>
        <button className="icon" onClick={() => void undo()} disabled={!undoId || busy} aria-label="Отменить ответ">
          ↩
        </button>
      </header>
      <div className="bar">
        <div className="bar-fill" style={{ width: `${progress}%` }} />
      </div>

      {me && me.decks.length > 1 && (
        <nav className="chips">
          {[{ id: 0, name: 'Все', due: me.decks.reduce((s, d) => s + d.due, 0) }, ...me.decks].map((d) => (
            <button key={d.id} className={d.id === scope ? 'chip active' : 'chip'} onClick={() => setScope(d.id)}>
              {d.name} <span>{d.due}</span>
            </button>
          ))}
        </nav>
      )}

      {card ? (
        <>
          <main className="stage" onClick={reveal}>
            <article key={`${card.id}-${card.version}`} className={`card ${phase}`}>
              <div className="card-meta">
                <span>{card.deckName}</span>
                <span className={`state s${card.state}`}>
                  {card.state === 0 ? 'новая' : card.state === 2 ? 'повторение' : 'обучение'}
                </span>
              </div>
              <Front card={card} />
              {phase === 'answer' && (
                <>
                  <hr />
                  <Back card={card} articleVerdict={verdict ?? undefined} />
                </>
              )}
            </article>
          </main>

          <footer className="actions">
            {card.template === 'article' ? (
              phase === 'question' ? (
                <div className="row three">
                  {ARTICLES.map((a) => (
                    <button key={a} className={`btn art-btn ${a}`} onClick={() => void pickArticle(a)} disabled={busy}>
                      {a}
                    </button>
                  ))}
                </div>
              ) : (
                <button className="btn primary wide" onClick={continueAfterArticle} disabled={busy || !pending.current}>
                  Дальше →
                </button>
              )
            ) : phase === 'question' ? (
              <button className="btn ghost wide" onClick={reveal}>
                Показать ответ
              </button>
            ) : (
              <div className="row four">
                {GRADES.map((g) => (
                  <button key={g.grade} className={`btn grade ${g.cls}`} onClick={() => void rate(g.grade)} disabled={busy}>
                    <span className="g-name">{g.name}</span>
                    <span className="g-int">{previews.get(g.grade)}</span>
                  </button>
                ))}
              </div>
            )}
          </footer>
        </>
      ) : (
        <main className="screen-body center">
          <div className="big-emoji">🎉</div>
          <h2>На сейчас всё!</h2>
          {done > 0 && <p className="muted">Сегодня в этой сессии: {done}</p>}
          {state.activeDecks === 0 ? (
            <p className="muted">Колод пока нет — загрузи карточки через бота.</p>
          ) : countdown ? (
            <>
              <p className="muted">Карточка из обучения вернётся через</p>
              <div className="countdown">{countdown}</div>
              <p className="muted small">Можно не закрывать — она появится сама.</p>
            </>
          ) : (
            <p className="muted">На сегодня карточек больше нет. Завтра будут новые 🙌</p>
          )}
          <button className="btn ghost" onClick={() => tg?.close()}>
            Закрыть
          </button>
        </main>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

