import { signInitData, validateInitData } from './telegram-auth';

const TOKEN = '123456:TEST_TOKEN';
const now = 1_800_000_000_000;
const user = JSON.stringify({ id: 4242, first_name: 'Женя' });

describe('validateInitData', () => {
  it('accepts correctly signed data and returns the user', () => {
    const init = signInitData({ auth_date: String(now / 1000 - 60), user, query_id: 'Q' }, TOKEN);
    expect(validateInitData(init, TOKEN, now)).toEqual({ id: 4242, first_name: 'Женя' });
  });

  it('accepts data where the signature field is excluded from the check', () => {
    const signed = signInitData({ auth_date: String(now / 1000), user }, TOKEN);
    const withSignature = `${signed}&signature=abc`;
    expect(validateInitData(withSignature, TOKEN, now)?.id).toBe(4242);
  });

  it('rejects tampered, foreign and expired data', () => {
    const init = signInitData({ auth_date: String(now / 1000), user }, TOKEN);
    expect(validateInitData(init.replace('4242', '4243'), TOKEN, now)).toBeNull();
    expect(validateInitData(init, '999:OTHER', now)).toBeNull();
    expect(validateInitData(init, TOKEN, now + 25 * 3600 * 1000)).toBeNull();
    expect(validateInitData('user=x', TOKEN, now)).toBeNull();
  });
});
