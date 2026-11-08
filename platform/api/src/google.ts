import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { unauthorized } from '@stacks/api';
import type { GoogleIdentity } from './model';

const GOOGLE_JWKS_URL = new URL('https://www.googleapis.com/oauth2/v3/certs');
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/**
 * Verify Google Identity Services ID tokens (the "Sign in with Google" credential). Ported from
 * Book Club. The JWKS is fetched lazily and cached for the life of the Lambda container.
 */
export function createGoogleVerifier(clientId: string, keySet?: JWTVerifyGetKey) {
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID is not configured');
  const jwks = keySet ?? createRemoteJWKSet(GOOGLE_JWKS_URL);
  return async function verifyGoogleToken(token: string): Promise<GoogleIdentity> {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, jwks, { issuer: GOOGLE_ISSUERS, audience: clientId }));
    } catch {
      throw unauthorized('Invalid or expired Google credential');
    }
    if (typeof payload.email !== 'string' || payload.email_verified !== true) throw unauthorized('Google account email is not verified');
    return {
      email: payload.email.toLowerCase(),
      name: typeof payload.name === 'string' ? payload.name : payload.email,
      picture: typeof payload.picture === 'string' ? payload.picture : undefined,
    };
  };
}
