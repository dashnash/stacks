import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { createAppleVerifier } from '../src/apple';
import { createPlatformHarness } from './helpers';

const BUNDLE = 'com.dashyhq.stacks.test';
const SERVICES = 'com.dashyhq.stacks.test.web';

async function keys() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'a1', alg: 'RS256' };
  const sign = (claims: Record<string, unknown>, aud = BUNDLE, iss = 'https://appleid.apple.com') =>
    new SignJWT({ email: 'x7dk2@privaterelay.appleid.com', email_verified: 'true', is_private_email: 'true', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'a1' })
      .setIssuer(iss)
      .setAudience(aud)
      .setSubject('001234.abcd.0042')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  return { jwks: createLocalJWKSet({ keys: [jwk] }), sign };
}

describe('Apple identity tokens', () => {
  it('accepts tokens for the iOS app or the web Services ID, from Apple only', async () => {
    const { jwks, sign } = await keys();
    const verify = createAppleVerifier([BUNDLE, SERVICES], jwks);
    await expect(verify(await sign({}))).resolves.toEqual({ sub: '001234.abcd.0042', email: 'x7dk2@privaterelay.appleid.com', name: '', privateEmail: true });
    await expect(verify(await sign({}, SERVICES))).resolves.toMatchObject({ sub: '001234.abcd.0042' });
    await expect(verify(await sign({}, 'com.someone.else'))).rejects.toThrow(/Invalid or expired/);
    await expect(verify(await sign({}, BUNDLE, 'https://evil.example'))).rejects.toThrow(/Invalid or expired/);
    await expect(verify(await sign({ email_verified: 'false' }))).rejects.toThrow(/not verified/);
    // A later sign-in may carry no email: the identity alone is enough for a known account.
    await expect(verify(await sign({ email: undefined, email_verified: undefined }))).resolves.toMatchObject({ email: '' });
    await expect(createAppleVerifier([], jwks)(await sign({}))).rejects.toThrow(/not set up/);
  });
});

describe('Sign in with Apple', () => {
  const signIn = (h: ReturnType<typeof createPlatformHarness>, credential: string, name?: string) =>
    h.call('POST', '/auth/apple', { body: { credential, ...(name ? { name } : {}) } });

  it('makes an account for a new person with a hidden email, named from the first sign-in, and signs them back in by Apple ID alone', async () => {
    const h = createPlatformHarness();
    const first = await signIn(h, 'apple:a-001:x7dk2@privaterelay.appleid.com', 'Priya Rao');
    expect(first.status).toBe(200);
    expect(first.body.user).toMatchObject({ name: 'Priya', email: 'x7dk2@privaterelay.appleid.com' });
    // Apple sends no name (and maybe no email) after the first time: nothing is lost.
    const again = await signIn(h, 'apple:a-001');
    expect(again.body.user).toMatchObject({ id: first.body.user.id, name: 'Priya', googleName: 'Priya Rao' });
  });

  it('needs an email to make a new account', async () => {
    const h = createPlatformHarness();
    expect((await signIn(h, 'apple:a-002')).status).toBe(400);
    expect((await signIn(h, 'nope')).status).toBe(401);
  });

  it('lets an existing person link their Apple ID, then sign in with it and keep their grants', async () => {
    const h = createPlatformHarness();
    await h.authorize('hello', 'ann@test.dev'); // a role in Hello
    const linked = await h.call('POST', '/me/identities/apple', { as: 'ann@test.dev', body: { credential: 'apple:a-ann:ann.relay@privaterelay.appleid.com' } });
    expect(linked.body).toEqual({ linked: true });
    const methods = (await h.call('GET', '/me/identities', { as: 'ann@test.dev' })).body.identities;
    expect(methods.map((m: { provider: string; primary: boolean }) => [m.provider, m.primary])).toEqual(expect.arrayContaining([['google', true], ['apple', false]]));
    const viaApple = await signIn(h, 'apple:a-ann');
    expect(viaApple.body.user.id).toBe(await h.idOf('ann@test.dev'));
    expect(viaApple.body.user.name).toBe('ann'); // the Google profile still leads
    const catalog = await h.call('GET', '/catalog', { cookies: { '__Host-stacks-portal': viaApple.cookies[0]!.split(';')[0]!.split('=')[1]! } });
    expect(catalog.body.apps.find((a: { slug: string }) => a.slug === 'hello').access).toBe('MEMBER');
    expect((await h.call('POST', '/me/identities/apple', { as: 'ann@test.dev', body: { credential: 'apple:a-ann' } })).status).toBe(409);
  });

  it('offers a merge when that Apple ID already has its own account', async () => {
    const h = createPlatformHarness();
    await signIn(h, 'apple:a-bob:bob.relay@privaterelay.appleid.com', 'Bob');
    const res = await h.call('POST', '/me/identities/apple', { as: 'ann@test.dev', body: { credential: 'apple:a-bob' } });
    expect(res.body).toMatchObject({ linked: false, ticket: expect.stringMatching(/^stm_/), plan: { other: { email: 'bob.relay@privaterelay.appleid.com' } } });
  });

  it('tells the portal whether Apple sign-in works on the web', async () => {
    const h = createPlatformHarness();
    expect((await h.call('GET', '/config')).body.appleServicesId).toBeNull();
    h.deps.config.appleServicesId = SERVICES;
    expect((await h.call('GET', '/config')).body.appleServicesId).toBe(SERVICES);
  });
});
