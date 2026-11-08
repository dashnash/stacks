import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { Router } from '../src/router';

const event = (method: string, path: string, extra: Partial<APIGatewayProxyEventV2> = {}) =>
  ({ rawPath: path, requestContext: { http: { method } }, headers: {}, ...extra }) as unknown as APIGatewayProxyEventV2;

describe('Router', () => {
  const router = new Router()
    .add('GET', '/items/:id', async (req) => ({ body: { id: req.params.id, q: req.query.q, c: req.cookies.a } }))
    .add('POST', '/items', async (req) => ({ status: 201, body: req.body }));

  it('matches params under /api, decodes them, and passes query and cookies', async () => {
    const res = (await router.handle(event('GET', '/api/items/a%20b', { queryStringParameters: { q: '1' }, cookies: ['a=x%3Dy', 'a=ignored'] }))) as any;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ id: 'a b', q: '1', c: 'x=y' });
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it('answers 404 for unknown paths and 405 for the wrong method', async () => {
    expect(((await router.handle(event('GET', '/api/nothing'))) as any).statusCode).toBe(404);
    expect(((await router.handle(event('DELETE', '/api/items'))) as any).statusCode).toBe(405);
  });

  it('rejects bodies that are not JSON objects or are too large', async () => {
    const post = (body: string) => router.handle(event('POST', '/api/items', { body }));
    expect(((await post('nope')) as any).statusCode).toBe(400);
    expect(((await post('[1]')) as any).statusCode).toBe(400);
    expect(((await post(JSON.stringify({ x: 'y'.repeat(300_000) }))) as any).statusCode).toBe(413);
    expect(((await post('{"a":1}')) as any).statusCode).toBe(201);
  });

  it('reads cookies from the Cookie header when API Gateway does not split them', async () => {
    const res = (await router.handle(event('GET', '/api/items/1', { headers: { Cookie: 'a=1; b=2' } }))) as any;
    expect(JSON.parse(res.body).c).toBe('1');
  });
});
