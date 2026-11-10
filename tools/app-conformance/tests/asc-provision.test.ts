import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain .mjs script, no types
import { appsFromConfig, ascToken, createApi, GROUP_NAME, missingApps, provision } from '../../../scripts/asc-provision.mjs';

type Row = { id: string; type: string; attributes: Record<string, any>; rel?: Record<string, string> };

/** A pretend App Store Connect: just enough of the endpoints the script uses, with a call log. */
function fakeAsc(opts: { apps?: { bundleId: string; name: string }[]; testers?: string[] } = {}) {
  let n = 0;
  const rows: Row[] = [];
  const add = (type: string, attributes: Record<string, any>, rel?: Record<string, string>) => {
    const row = { id: `${type}-${++n}`, type, attributes, rel };
    rows.push(row);
    return row;
  };
  for (const a of opts.apps ?? []) add('apps', { bundleId: a.bundleId, name: a.name });
  for (const e of opts.testers ?? []) add('betaTesters', { email: e });
  const members = new Map<string, Set<string>>();
  const calls: string[] = [];
  const of = (type: string) => rows.filter((r) => r.type === type);
  const api = async (method: string, path: string, body?: any) => {
    calls.push(`${method} ${path.split('?')[0]}`);
    const [p, qs = ''] = path.split('?');
    const filter = Object.fromEntries([...new URLSearchParams(qs)].filter(([k]) => k.startsWith('filter[')).map(([k, v]) => [k.slice(7, -1), v]));
    let m: RegExpMatchArray | null;
    if (method === 'GET' && p === '/v1/bundleIds') return { data: of('bundleIds').filter((b) => b.attributes.identifier.startsWith(filter.identifier)) };
    if (method === 'POST' && p === '/v1/bundleIds') return { data: add('bundleIds', body.data.attributes) };
    if (method === 'GET' && (m = p!.match(/^\/v1\/bundleIds\/(.+)\/bundleIdCapabilities$/))) return { data: of('caps').filter((c) => c.rel?.bundleId === m![1]) };
    if (method === 'POST' && p === '/v1/bundleIdCapabilities') return { data: add('caps', body.data.attributes, { bundleId: body.data.relationships.bundleId.data.id }) };
    if (method === 'GET' && p === '/v1/apps') return { data: of('apps').filter((a) => a.attributes.bundleId === filter.bundleId) };
    if (method === 'GET' && (m = p!.match(/^\/v1\/apps\/(.+)\/betaGroups$/))) return { data: of('betaGroups').filter((g) => g.rel?.app === m![1]) };
    if (method === 'POST' && p === '/v1/betaGroups') return { data: add('betaGroups', body.data.attributes, { app: body.data.relationships.app.data.id }) };
    if (method === 'GET' && p === '/v1/betaTesters') return { data: of('betaTesters').filter((t) => t.attributes.email === filter.email) };
    if (method === 'POST' && p === '/v1/betaTesters') {
      const t = add('betaTesters', body.data.attributes);
      for (const g of body.data.relationships.betaGroups.data) (members.get(g.id) ?? members.set(g.id, new Set()).get(g.id)!).add(t.id);
      return { data: t };
    }
    if (method === 'GET' && (m = p!.match(/^\/v1\/betaGroups\/(.+)\/betaTesters$/))) return { data: [...(members.get(m[1]!) ?? [])].map((id) => ({ id })) };
    if (method === 'POST' && (m = p!.match(/^\/v1\/betaGroups\/(.+)\/relationships\/betaTesters$/))) {
      for (const t of body.data) (members.get(m[1]!) ?? members.set(m[1]!, new Set()).get(m[1]!)!).add(t.id);
      return {};
    }
    throw new Error(`fake ASC has no ${method} ${path}`);
  };
  return { api, rows, of, calls, members };
}

const apps = appsFromConfig({
  environments: {
    production: { native: { iosBundleId: 'com.dashyhq.stacks' } },
    staging: { native: { iosBundleId: 'com.dashyhq.stacks.test' } },
  },
});

describe('App Store Connect provisioning', () => {
  it('signs tokens the way Apple checks them (ES256, 15 minutes, its audience)', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const token = ascToken({ keyId: 'KEY123', issuerId: 'issuer-uuid', privateKeyPem: pem, now: 1_000_000_000 });
    const [h, p, s] = token.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'KEY123', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toEqual({ iss: 'issuer-uuid', iat: 1_000_000, exp: 1_000_900, aud: 'appstoreconnect-v1' });
    expect(verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))).toBe(true);
  });

  it("registers both bundle IDs with Associated Domains, and says which app records it can't create", async () => {
    const asc = fakeAsc();
    const log: string[] = [];
    expect(await provision({ api: asc.api, apps, log: (l: string) => log.push(l) })).toEqual({ appsMissing: 2 });
    expect(asc.of('bundleIds').map((b) => [b.attributes.identifier, b.attributes.name, b.attributes.platform])).toEqual([
      ['com.dashyhq.stacks', 'DashyHQ', 'IOS'],
      ['com.dashyhq.stacks.test', 'DashyHQ Test', 'IOS'],
    ]);
    expect(asc.of('caps').map((c) => c.attributes.capabilityType)).toEqual(['ASSOCIATED_DOMAINS', 'ASSOCIATED_DOMAINS']);
    expect(log.filter((l) => l.startsWith('!'))).toHaveLength(2);
  });

  it('then makes each app an automatic internal TestFlight group with the tester, and a re-run changes nothing', async () => {
    const asc = fakeAsc({ apps: [{ bundleId: 'com.dashyhq.stacks', name: 'DashyHQ' }, { bundleId: 'com.dashyhq.stacks.test', name: 'DashyHQ Test' }], testers: ['dash@example.com'] });
    expect(await provision({ api: asc.api, apps, testerEmail: 'dash@example.com', log: () => {} })).toEqual({ appsMissing: 0 });
    const groups = asc.of('betaGroups');
    expect(groups.map((g) => g.attributes)).toEqual([
      { name: GROUP_NAME, isInternalGroup: true, hasAccessToAllBuilds: true },
      { name: GROUP_NAME, isInternalGroup: true, hasAccessToAllBuilds: true },
    ]);
    const testerId = asc.of('betaTesters')[0]!.id;
    for (const g of groups) expect([...asc.members.get(g.id)!]).toEqual([testerId]);

    const before = asc.calls.length;
    await provision({ api: asc.api, apps, testerEmail: 'dash@example.com', log: () => {} });
    expect(asc.calls.slice(before).filter((c) => c.startsWith('POST'))).toEqual([]);
  });

  it("doesn't mistake one bundle ID for another that starts the same", async () => {
    const asc = fakeAsc();
    await provision({ api: asc.api, apps: [apps[1]!], log: () => {} }); // only ….test
    await provision({ api: asc.api, apps: [apps[0]!], log: () => {} }); // the GET also returns ….test
    expect(asc.of('bundleIds').map((b) => b.attributes.identifier).sort()).toEqual(['com.dashyhq.stacks', 'com.dashyhq.stacks.test']);
  });

  it("reports Apple's error details", async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const api = createApi({
      keyId: 'K',
      issuerId: 'I',
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      fetchImpl: (async () => new Response(JSON.stringify({ errors: [{ title: 'Forbidden', detail: 'Admin role needed' }] }), { status: 403 })) as typeof fetch,
    });
    await expect(api('GET', '/v1/apps')).rejects.toThrow('GET /v1/apps → 403 Forbidden: Admin role needed');
  });

  it('tells the release job which app records are still missing', async () => {
    const none = fakeAsc();
    expect((await missingApps(none.api, apps)).map((a: { bundleId: string }) => a.bundleId)).toEqual(['com.dashyhq.stacks', 'com.dashyhq.stacks.test']);
    const one = fakeAsc({ apps: [{ bundleId: 'com.dashyhq.stacks.test', name: 'DashyHQ Test' }] });
    expect((await missingApps(one.api, apps)).map((a: { bundleId: string }) => a.bundleId)).toEqual(['com.dashyhq.stacks']);
    const both = fakeAsc({ apps: [{ bundleId: 'com.dashyhq.stacks', name: 'DashyHQ' }, { bundleId: 'com.dashyhq.stacks.test', name: 'DashyHQ Test' }] });
    expect(await missingApps(both.api, apps)).toEqual([]);
  });
});
