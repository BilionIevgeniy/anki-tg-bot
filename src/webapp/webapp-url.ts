import type { Env } from '../config/env';

export const WEBAPP_PATH = '/app';

/** Public URL of the Mini App, or undefined when the bot has no https URL (polling/dev). */
export function webAppUrl(env: Pick<Env, 'PUBLIC_URL'>): string | undefined {
  return env.PUBLIC_URL ? `${env.PUBLIC_URL.replace(/\/$/, '')}${WEBAPP_PATH}/` : undefined;
}
