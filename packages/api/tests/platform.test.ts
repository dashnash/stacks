import { describe, expect, it } from 'vitest';
import { HttpPlatformClient, PlatformError } from '../src/platform';

describe('HttpPlatformClient', () => {
  it('posts to the app-scoped platform endpoint with the app credential', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new HttpPlatformClient({
      baseUrl: 'https://auth.example.com/api',
      appSlug: 'notes',
      credential: async () => 'cred-123',
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ user: { id: 'u_a', email: 'a@b.c', name: 'A' }, role: 'READER' }), { status: 200 });
      }) as typeof fetch,
    });
    const res = await client.exchangeCode({ code: 'c', codeVerifier: 'v', redirectUri: 'https://notes.example.com/api/auth/callback' });
    expect(res.role).toBe('READER');
    expect(calls[0]!.url).toBe('https://auth.example.com/api/apps/notes/token');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer cred-123');
  });

  it('turns error responses into PlatformError', async () => {
    const client = new HttpPlatformClient({
      baseUrl: 'https://p',
      appSlug: 'notes',
      credential: async () => 'x',
      fetch: (async () => new Response(JSON.stringify({ error: 'bad code', code: 'INVALID_GRANT' }), { status: 400 })) as unknown as typeof fetch,
    });
    await expect(client.exchangeCode({ code: 'c', codeVerifier: 'v', redirectUri: 'r' })).rejects.toEqual(new PlatformError(400, 'bad code', 'INVALID_GRANT'));
  });
});
