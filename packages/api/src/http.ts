import type { APIGatewayProxyResultV2 } from 'aws-lambda';

/** An error that becomes a JSON response `{ error, code }` with its status. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new HttpError(400, message, 'BAD_REQUEST');
/** Every route but health checks answers this while `maintenance` is on (the user-id cut-over). */
export const maintenance = () => new HttpError(503, 'Stacks is being upgraded. Back in a few minutes.', 'MAINTENANCE');
/** Paths that keep working during maintenance. */
export const MAINTENANCE_OPEN_PATHS = new Set(['/health', '/config', '/native/config']);
export const unauthorized = (message = 'Sign in required') => new HttpError(401, message, 'UNAUTHORIZED');
export const forbidden = (message: string, code = 'FORBIDDEN') => new HttpError(403, message, code);
export const notFound = (message: string) => new HttpError(404, message, 'NOT_FOUND');
export const conflict = (message: string) => new HttpError(409, message, 'CONFLICT');

/** What a route returns. `redirect` sends a 302 to that URL instead of a JSON body. */
export interface RouteResult {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Full `Set-Cookie` values. */
  cookies?: string[];
  redirect?: string;
}

export function toResponse(result: RouteResult): APIGatewayProxyResultV2 {
  const headers: Record<string, string> = { 'Cache-Control': 'no-store', ...result.headers };
  const cookies = result.cookies?.length ? { cookies: result.cookies } : {};
  if (result.redirect) {
    return { statusCode: result.status ?? 302, headers: { ...headers, Location: result.redirect }, body: '', ...cookies };
  }
  return {
    statusCode: result.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(result.body ?? {}),
    ...cookies,
  };
}

export function errorResponse(err: unknown): APIGatewayProxyResultV2 {
  if (err instanceof HttpError) return toResponse({ status: err.status, body: { error: err.message, code: err.code } });
  console.error('Unhandled error', err);
  return toResponse({ status: 500, body: { error: 'Internal server error', code: 'INTERNAL' } });
}

/** Read a required, non-empty string field from a parsed JSON body. */
export function requireString(body: Record<string, unknown>, field: string, maxLength = 10_000): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') throw badRequest(`"${field}" is required`);
  if (value.length > maxLength) throw badRequest(`"${field}" must be at most ${maxLength} characters`);
  return value.trim();
}

export function optionalString(body: Record<string, unknown>, field: string, maxLength = 10_000): string | undefined {
  const value = body[field];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw badRequest(`"${field}" must be a string`);
  if (value.length > maxLength) throw badRequest(`"${field}" must be at most ${maxLength} characters`);
  return value.trim();
}

export function requireIsoDate(body: Record<string, unknown>, field: string): string {
  const value = requireString(body, field);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw badRequest(`"${field}" must be an ISO-8601 date-time`);
  return date.toISOString();
}

export function optionalUrl(body: Record<string, unknown>, field: string): string | undefined {
  const value = optionalString(body, field);
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('bad protocol');
  } catch {
    throw badRequest(`"${field}" must be an http(s) URL`);
  }
  return value;
}

export function optionalInt(body: Record<string, unknown>, field: string, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw badRequest(`"${field}" must be a whole number from ${min} to ${max}`);
  }
  return value;
}
