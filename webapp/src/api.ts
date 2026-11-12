import { tg } from './telegram';

export interface Preview {
  grade: number;
  label: string;
}

export interface CardDto {
  id: number;
  version: number;
  template: 'ru_de' | 'de_ru' | 'article' | 'fwd' | 'rev';
  state: number;
  deckId: number;
  deckName: string;
  note: { type: 'vocab_de' | 'basic'; fields: Record<string, unknown> };
  previews: Preview[];
}

export interface Counts {
  learning: number;
  review: number;
  new: number;
  total: number;
}

export interface Progress {
  /** cards finished for today */
  done: number;
  /** done + cards still to do today — stable across "Again", learning steps and reopening */
  total: number;
}

export interface NextDto {
  card: CardDto | null;
  counts: Counts;
  progress: Progress;
  nextLearningDue: string | null;
  activeDecks: number;
}

export interface AnswerDto {
  ok: boolean;
  logId?: number;
  label?: string;
  leech?: boolean;
  next: NextDto;
}

export interface MeDto {
  firstName: string | null;
  decks: { id: number; name: string; due: number }[];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${import.meta.env.BASE_URL.replace(/\/app\/$/, '')}/api/app${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `tma ${tg?.initData ?? ''}`,
      ...init?.headers,
    },
  });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return (await res.json()) as T;
}

export const api = {
  me: () => call<MeDto>('/me'),
  next: (scope: number) => call<NextDto>(`/next?scope=${scope}`),
  answer: (body: { cardId: number; version: number; grade: number; scope: number }) =>
    call<AnswerDto>('/answer', { method: 'POST', body: JSON.stringify(body) }),
  undo: (logId: number, scope: number) =>
    call<{ ok: boolean; next: NextDto }>('/undo', {
      method: 'POST',
      body: JSON.stringify({ logId, scope }),
    }),
};
