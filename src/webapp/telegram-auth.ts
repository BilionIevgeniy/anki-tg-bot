import { createHmac, timingSafeEqual } from 'node:crypto';

export interface WebAppUser {
  id: number;
  first_name?: string;
  language_code?: string;
}

/**
 * Validates Telegram Mini App `initData` (bot-token HMAC scheme):
 *   secret = HMAC_SHA256(key = "WebAppData", data = botToken)
 *   hash   = hex(HMAC_SHA256(key = secret, data = data_check_string))
 * data_check_string = all fields except `hash`, sorted by key, "key=value" joined by "\n".
 * Newer clients also send `signature` (for Ed25519 third-party checks); we accept the
 * data-check-string both with and without it.
 */
export function validateInitData(
  initData: string,
  botToken: string,
  now = Date.now(),
  maxAgeSec = 24 * 60 * 60,
): WebAppUser | null {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[a-f0-9]{64}$/.test(hash)) return null;

  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const check = (exclude: string[]) => {
    const dcs = [...params.entries()]
      .filter(([k]) => !exclude.includes(k))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const expected = createHmac('sha256', secret).update(dcs).digest();
    return timingSafeEqual(expected, Buffer.from(hash, 'hex'));
  };
  if (!check(['hash']) && !(params.has('signature') && check(['hash', 'signature']))) return null;

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || now / 1000 - authDate > maxAgeSec) return null;

  try {
    const user = JSON.parse(params.get('user') ?? 'null') as WebAppUser | null;
    return user && Number.isInteger(user.id) ? user : null;
  } catch {
    return null;
  }
}

/** Builds a valid initData string — used in tests and local development. */
export function signInitData(fields: Record<string, string>, botToken: string): string {
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const dcs = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  const hash = createHmac('sha256', secret).update(dcs).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}
