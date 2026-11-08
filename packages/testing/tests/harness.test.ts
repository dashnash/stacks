import { describe, expect, it } from 'vitest';
import { cookieValue, FakePlatform } from '../src/index';

describe('FakePlatform', () => {
  it('issues single-use codes', async () => {
    const p = new FakePlatform();
    const code = p.issueCode({ email: 'a@b.c', name: 'A' }, 'MEMBER');
    expect(await p.exchangeCode({ code, codeVerifier: 'v', redirectUri: 'r' })).toEqual({ user: { email: 'a@b.c', name: 'A' }, role: 'MEMBER' });
    await expect(p.exchangeCode({ code, codeVerifier: 'v', redirectUri: 'r' })).rejects.toThrow(/used/);
  });
});

describe('cookieValue', () => {
  it('reads a value out of Set-Cookie headers', () => {
    expect(cookieValue(['a=1; Path=/', 'b=x%20y; HttpOnly'], 'b')).toBe('x y');
    expect(cookieValue(['a=1'], 'c')).toBeUndefined();
  });
});
