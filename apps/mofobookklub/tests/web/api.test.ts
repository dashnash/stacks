import { describe, expect, it, vi } from 'vitest';
import { createClient } from '@stacks/web';
import { ApiError, createApi } from '../../web/src/lib/api';

function respond(status: number, body: unknown) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

describe('createApi', () => {
  it('sends JSON with the session cookie and CSRF header to /api', async () => {
    const fetch = respond(200, { meeting: {} });
    const api = createApi(createClient({ fetch }));
    await api.chooseBook('m1', { nominationId: 'n1' });
    expect(fetch).toHaveBeenCalledWith('/api/meetings/m1/book', {
      method: 'POST',
      headers: { 'X-Stacks-Request': '1', 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ nominationId: 'n1' }),
    });
  });

  it('URL-encodes search queries', async () => {
    const fetch = respond(200, { results: [] });
    await createApi(createClient({ fetch })).searchBooks('war & peace');
    expect(fetch.mock.calls[0]![0]).toBe('/api/books/search?q=war%20%26%20peace');
  });

  it('throws ApiError with the server message and code', async () => {
    const api = createApi(createClient({ fetch: respond(403, { error: 'Admins only', code: 'FORBIDDEN' }) }));
    const err = await api.access().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 403, code: 'FORBIDDEN', message: 'Admins only' });
  });

  it('calls onUnauthorized on 401', async () => {
    const onUnauthorized = vi.fn();
    const api = createApi(createClient({ fetch: respond(401, { error: 'expired' }), onUnauthorized }));
    await expect(api.history()).rejects.toThrow('expired');
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('changes access through the SDK route', async () => {
    const fetch = respond(200, { ok: true });
    await createApi(createClient({ fetch })).setAccess('bob@club.test', 'ADMIN');
    expect(fetch.mock.calls[0]![0]).toBe('/api/stacks/access/bob%40club.test');
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: 'PUT', body: '{"role":"ADMIN"}' });
  });
});

describe('poster date helpers', () => {
  it('splits a meeting time into headline parts', async () => {
    const { posterDate, daysUntil } = await import('../../web/src/lib/format');
    const local = new Date(2026, 10, 19, 19, 0);
    expect(posterDate(local.toISOString())).toMatchObject({ weekday: 'Thu', month: 'Nov', day: '19', time: '7pm' });
    expect(posterDate(new Date(2026, 10, 19, 9, 30).toISOString()).time).toBe('9:30am');
    expect(daysUntil(local.toISOString(), new Date(2026, 10, 7, 23, 0))).toBe(12);
    expect(daysUntil(local.toISOString(), new Date(2026, 10, 19, 8, 0))).toBe(0);
  });
});
