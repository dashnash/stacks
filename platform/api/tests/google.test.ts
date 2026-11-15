import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { createGoogleVerifier } from '../src/google';
import { createPlatformHarness, privateApp, publicApp } from './helpers';

const WEB = 'web-client.apps.googleusercontent.com';
const IOS = 'ios-client.apps.googleusercontent.com';

async function keys() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
  const sign = (claims: Record<string, unknown>) =>
    new SignJWT({ email: 'ann@test.dev', email_verified: true, name: 'Ann', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer('https://accounts.google.com')
      .setAudience(WEB)
      .setSubject('g-ann')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  return { jwks: createLocalJWKSet({ keys: [jwk] }), sign };
}

describe('Google ID tokens', () => {
  it('accepts tokens for the web client, and from our iOS app (azp) only', async () => {
    const { jwks, sign } = await keys();
    const verify = createGoogleVerifier(WEB, jwks, [IOS]);
    await expect(verify(await sign({}))).resolves.toMatchObject({ sub: 'g-ann', email: 'ann@test.dev' });
    await expect(verify(await sign({ azp: WEB }))).resolves.toMatchObject({ sub: 'g-ann' });
    await expect(verify(await sign({ azp: IOS }))).resolves.toMatchObject({ sub: 'g-ann' });
    await expect(verify(await sign({ azp: 'someone-else.apps.googleusercontent.com' }))).rejects.toThrow(/unknown app/);
    // Without iOS clients configured, the app's tokens are refused.
    await expect(createGoogleVerifier(WEB, jwks)(await sign({ azp: IOS }))).rejects.toThrow(/unknown app/);
  });
});

describe('/native/config', () => {
  it('tells the iOS app which hosts open inside it, even during maintenance', async () => {
    const h = createPlatformHarness({ apps: [privateApp, { ...publicApp, native: ['motion', 'haptics'] }] });
    h.deps.config.maintenance = true;
    const res = await h.call('GET', '/native/config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      protocol: 1,
      minShellVersion: '1.0.0',
      authHost: 'auth.stacks.test',
      apps: [
        { slug: 'club', name: 'Book Club', host: 'club.stacks.test', native: [] },
        { slug: 'hello', name: 'Hello Board', host: 'hello.stacks.test', native: ['motion', 'haptics'] },
      ],
    });
  });
});
