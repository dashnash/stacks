import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { unauthorized } from '@stacks/api';
import type { GoogleIdentity } from './model';

const APPLE_JWKS_URL = new URL('https://appleid.apple.com/auth/keys');
const APPLE_ISSUER = 'https://appleid.apple.com';

/** An Apple identity: no photo, and the name only on the first sign-in (the client sends it). */
export type AppleIdentity = Omit<GoogleIdentity, 'picture'> & { privateEmail: boolean };

/**
 * Verify Sign in with Apple identity tokens. `audiences` are the iOS app's bundle ID (native
 * sign-in) and the web Services ID (Apple JS on the portal). Apple's `sub` is stable per developer
 * team. The email is present when the person shared one (a hidden email is a
 * `@privaterelay.appleid.com` address); Apple vouches for it, so it is always treated as verified.
 */
export function createAppleVerifier(audiences: string[], keySet?: JWTVerifyGetKey) {
  const jwks = keySet ?? createRemoteJWKSet(APPLE_JWKS_URL);
  return async function verifyAppleToken(token: string): Promise<AppleIdentity> {
    if (!audiences.length) throw unauthorized('Sign in with Apple is not set up here');
    let payload;
    try {
      ({ payload } = await jwtVerify(token, jwks, { issuer: APPLE_ISSUER, audience: audiences }));
    } catch {
      throw unauthorized('Invalid or expired Apple credential');
    }
    if (typeof payload.sub !== 'string' || !payload.sub) throw unauthorized('Apple credential has no account id');
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
    const flag = (v: unknown) => v === true || v === 'true';
    if (email && payload.email_verified !== undefined && !flag(payload.email_verified)) throw unauthorized('Apple account email is not verified');
    return { sub: payload.sub, email, name: '', privateEmail: flag(payload.is_private_email) };
  };
}
