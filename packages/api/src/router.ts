import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { badRequest, errorResponse, HttpError, notFound, toResponse, type RouteResult } from './http';
import { runInLogScope, writeLog, type LogScope } from './log';

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
  private readonly hooks: ((method: HttpMethod, path: string) => void)[] = [];

  /** Run before any route matches; throw an {@link HttpError} to answer instead (e.g. maintenance). */
  before(hook: (method: HttpMethod, path: string) => void): this {
    this.hooks.push(hook);
    return this;
  }

  add(method: HttpMethod, pattern: string, handler: RouteHandler): this {
    this.routes.push({ method, segments: split(pattern), handler });
    return this;
  }

  /** `app` names the API on its log lines: the app's slug, or "platform". */
  constructor(private readonly opts: { app?: string } = {}) {}

  /**
   * Answer one request. Everything logged while it runs carries its request id and ref, and when
   * it finishes one `request` line is written: method, route pattern, status and duration.
   */
  handle(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const requestId = event.requestContext?.requestId || globalThis.crypto.randomUUID();
    const scope: LogScope = { ...(this.opts.app ? { app: this.opts.app } : {}), requestId, ref: requestId.slice(0, 8), route: 'unmatched' };
    return runInLogScope(scope, async () => {
      const started = Date.now();
      const response = await this.dispatch(event, scope);
      writeLog('request', 'info', 'request', {
        method: String(event.requestContext?.http?.method ?? '').toUpperCase(),
        status: typeof response === 'string' ? 200 : (response.statusCode ?? 200),
        durationMs: Date.now() - started,
      });
      return response;
    });
  }

  private async dispatch(event: APIGatewayProxyEventV2, scope: LogScope): Promise<APIGatewayProxyResultV2> {
    try {
      const method = event.requestContext.http.method.toUpperCase() as HttpMethod;
      let path = event.rawPath || '/';
      const prefixed = path === API_PREFIX || path.startsWith(`${API_PREFIX}/`);
      if (prefixed) path = path.slice(API_PREFIX.length) || '/';
      const segments = split(path);
      const candidates = this.routes.flatMap((route) => {
        const params = match(route.segments, segments);
        return params ? [{ route, params }] : [];
      });
      const found = candidates.find((c) => c.route.method === method);
      // The pattern, never the raw path: ids in a path can be personal, and patterns group in metrics.
      const named = found ?? candidates[0];
      if (named) scope.route = `${prefixed ? API_PREFIX : ''}/${named.route.segments.join('/')}`;
      for (const hook of this.hooks) hook(method, path);
      if (found) {
        const headers = lowerCaseHeaders(event.headers ?? {});
        const result = await found.route.handler({
          method,
          path,
          params: found.params,
          query: (event.queryStringParameters ?? {}) as Record<string, string>,
          headers,
          cookies: parseCookies(event.cookies ?? (headers.cookie ? headers.cookie.split(';') : [])),
          body: parseBody(event),
        });
        return toResponse(result);
      }
      if (candidates.length) throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED');
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
