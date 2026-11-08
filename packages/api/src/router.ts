import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { badRequest, errorResponse, HttpError, notFound, toResponse, type RouteResult } from './http';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface RequestContext {
  method: HttpMethod;
  /** Path without the `/api` prefix, e.g. `/greetings/42`. */
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  /** Request cookies by name. */
  cookies: Record<string, string>;
  /** Parsed JSON body; `{}` when the request has none. */
  body: Record<string, unknown>;
}

export type RouteHandler = (req: RequestContext) => Promise<RouteResult>;

interface Route {
  method: HttpMethod;
  segments: string[];
  handler: RouteHandler;
}

/** The API is served under this prefix; CloudFront forwards `/api/*` unchanged. */
export const API_PREFIX = '/api';
/** Largest request body accepted, in bytes. */
export const MAX_BODY_BYTES = 256 * 1024;

export class Router {
  private readonly routes: Route[] = [];

  add(method: HttpMethod, pattern: string, handler: RouteHandler): this {
    this.routes.push({ method, segments: split(pattern), handler });
    return this;
  }

  async handle(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    try {
      const method = event.requestContext.http.method.toUpperCase() as HttpMethod;
      let path = event.rawPath || '/';
      if (path === API_PREFIX || path.startsWith(`${API_PREFIX}/`)) path = path.slice(API_PREFIX.length) || '/';
      const segments = split(path);

      let pathMatched = false;
      for (const route of this.routes) {
        const params = match(route.segments, segments);
        if (!params) continue;
        pathMatched = true;
        if (route.method !== method) continue;
        const headers = lowerCaseHeaders(event.headers ?? {});
        const result = await route.handler({
          method,
          path,
          params,
          query: (event.queryStringParameters ?? {}) as Record<string, string>,
          headers,
          cookies: parseCookies(event.cookies ?? (headers.cookie ? headers.cookie.split(';') : [])),
          body: parseBody(event),
        });
        return toResponse(result);
      }
      if (pathMatched) throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED');
      throw notFound(`No route for ${method} ${path}`);
    } catch (err) {
      return errorResponse(err);
    }
  }
}

function split(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function match(pattern: string[], actual: string[]): Record<string, string> | null {
  if (pattern.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]!;
    const a = actual[i]!;
    if (p.startsWith(':')) params[p.slice(1)] = decodeSegment(a);
    else if (p !== a) return null;
  }
  return params;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw badRequest('Malformed URL');
  }
}

function lowerCaseHeaders(headers: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (v !== undefined) out[k.toLowerCase()] = v;
  return out;
}

/** `name=value` pairs (API Gateway v2 passes them as `event.cookies`). The first of a repeated name wins. */
export function parseCookies(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const i = pair.indexOf('=');
    if (i < 1) continue;
    const name = pair.slice(0, i).trim();
    if (!(name in out)) {
      try {
        out[name] = decodeURIComponent(pair.slice(i + 1).trim());
      } catch {
        // ignore malformed values
      }
    }
  }
  return out;
}

function parseBody(event: APIGatewayProxyEventV2): Record<string, unknown> {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  if (raw.length > MAX_BODY_BYTES) throw new HttpError(413, 'Request body is too large', 'TOO_LARGE');
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw badRequest('Request body must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof SyntaxError) throw badRequest('Request body is not valid JSON');
    throw err;
  }
}
