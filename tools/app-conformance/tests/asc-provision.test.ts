import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain .mjs script, no types
import { appsFromConfig, ascToken, createApi, freshProfiles, noteBuilds, GROUP_NAME, leftoverCertificates, missingApps, profileName, profileUuids, provision, releaseSigning, revokeCertificate } from '../../../scripts/asc-provision.mjs';

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
      // Like Apple: inviting an email that is already a tester adds that tester to the group.
      const t = of('betaTesters').find((x) => x.attributes.email === body.data.attributes.email) ?? add('betaTesters', body.data.attributes);
      for (const g of body.data.relationships.betaGroups.data) (members.get(g.id) ?? members.set(g.id, new Set()).get(g.id)!).add(t.id);
      return { data: t };
    }
    if (method === 'GET' && (m = p!.match(/^\/v1\/betaGroups\/(.+)\/betaTesters$/))) return { data: [...(members.get(m[1]!) ?? [])].map((id) => ({ id })) };
    if (method === 'POST' && (m = p!.match(/^\/v1\/betaGroups\/(.+)\/relationships\/betaTesters$/))) {
      // Like Apple (seen on the first real run): an existing tester can't be assigned to an internal group this way.
      if (of('betaGroups').find((g) => g.id === m![1])?.attributes.isInternalGroup) {
        throw new Error(`POST ${path} → 409 The request cannot be fulfilled because of the state of another resource.: Tester(s) cannot be assigned`);
      }
      for (const t of body.data) (members.get(m[1]!) ?? members.set(m[1]!, new Set()).get(m[1]!)!).add(t.id);
      return {};
    }
    if (method === 'POST' && p === '/v1/certificates') {
      if (of('certificates').length >= 3) throw new Error('POST /v1/certificates → 409 There is a problem with the request entity: You already have a current Distribution certificate or a pending certificate request.');
      return { data: add('certificates', { ...body.data.attributes, certificateContent: Buffer.from('DER').toString('base64'), expirationDate: '2027-11-11' }) };
    }
    if (method === 'DELETE' && (m = p!.match(/^\/v1\/certificates\/(.+)$/))) {
      const at = rows.findIndex((r) => r.type === 'certificates' && r.id === m![1]);
      if (at < 0) throw new Error(`DELETE ${path} → 404 The specified resource does not exist`);
      rows.splice(at, 1);
      return {};
    }
    if (method === 'GET' && (m = p!.match(/^\/v1\/profiles\/(.+)\/certificates$/))) {
      const cert = rows.find((r) => r.id === m![1])?.rel?.certificate;
      return { data: of('certificates').filter((c) => c.id === cert) };
    }
    if (method === 'GET' && p === '/v1/profiles') return { data: of('profiles').filter((r) => r.attributes.name === filter.name) };
    if (method === 'POST' && p === '/v1/profiles') {
      const r = body.data.relationships;
      return { data: add('profiles', { ...body.data.attributes, uuid: `uuid-${n + 1}`, profileContent: Buffer.from(`profile ${n + 1}`).toString('base64') }, { bundleId: r.bundleId.data.id, certificate: r.certificates.data[0].id }) };
    }
    if (method === 'DELETE' && (m = p!.match(/^\/v1\/profiles\/(.+)$/))) {
      rows.splice(rows.findIndex((r) => r.id === m![1]), 1);
      return {};
    }
    if (method === 'GET' && p === '/v1/builds') return { data: of('builds').filter((b) => b.rel?.app === filter.app && b.attributes.version === filter.version) };
    if (method === 'GET' && (m = p!.match(/^\/v1\/builds\/(.+)\/betaBuildLocalizations$/))) return { data: of('notes').filter((l) => l.rel?.build === m![1]) };
    if (method === 'POST' && p === '/v1/betaBuildLocalizations') return { data: add('notes', body.data.attributes, { build: body.data.relationships.build.data.id }) };
    if (method === 'PATCH' && (m = p!.match(/^\/v1\/betaBuildLocalizations\/(.+)$/))) {
      Object.assign(rows.find((r) => r.id === m![1])!.attributes, body.data.attributes);
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

  it("registers both bundle IDs with Associated Domains and push, and says which app records it can't create", async () => {
    const asc = fakeAsc();
    const log: string[] = [];
    expect(await provision({ api: asc.api, apps, log: (l: string) => log.push(l) })).toEqual({ appsMissing: 2 });
    expect(asc.of('bundleIds').map((b) => [b.attributes.identifier, b.attributes.name, b.attributes.platform])).toEqual([
      ['com.dashyhq.stacks', 'DashyHQ', 'IOS'],
      ['com.dashyhq.stacks.test', 'DashyHQ Test', 'IOS'],
    ]);
    expect(asc.of('caps').map((c) => c.attributes.capabilityType)).toEqual([
      'ASSOCIATED_DOMAINS', 'PUSH_NOTIFICATIONS', 'APPLE_ID_AUTH',
      'ASSOCIATED_DOMAINS', 'PUSH_NOTIFICATIONS', 'APPLE_ID_AUTH',
    ]);
    // Sign in with Apple: each app is its own primary App ID.
    expect(asc.of('caps').find((c) => c.attributes.capabilityType === 'APPLE_ID_AUTH')!.attributes.settings).toEqual([
      { key: 'APPLE_ID_AUTH_APP_CONSENT', options: [{ key: 'PRIMARY_APP_CONSENT' }] },
    ]);
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

  it('adds a new tester to both apps (the first real run failed here on the second app)', async () => {
    const asc = fakeAsc({ apps: [{ bundleId: 'com.dashyhq.stacks', name: 'DashyHQ' }, { bundleId: 'com.dashyhq.stacks.test', name: 'DashyHQ Test' }] });
    const log: string[] = [];
    await provision({ api: asc.api, apps, testerEmail: 'dash@example.com', log: (l: string) => log.push(l) });
    expect(asc.of('betaTesters')).toHaveLength(1);
    const testerId = asc.of('betaTesters')[0]!.id;
    for (const g of asc.of('betaGroups')) expect([...asc.members.get(g.id)!]).toEqual([testerId]);
    expect(log.filter((l) => l.startsWith('!'))).toEqual([]);
  });

  it("finishes the run if Apple won't take the tester at all, saying how to add them by hand", async () => {
    const asc = fakeAsc({ apps: [{ bundleId: 'com.dashyhq.stacks', name: 'DashyHQ' }] });
    const refusing = async (method: string, path: string, body?: unknown) => {
      if (method === 'POST' && path === '/v1/betaTesters') throw new Error('POST /v1/betaTesters → 409 Not a team member');
      return asc.api(method, path, body);
    };
    const log: string[] = [];
    expect(await provision({ api: refusing, apps: [apps[0]!], testerEmail: 'friend@example.com', log: (l: string) => log.push(l) })).toEqual({ appsMissing: 0 });
    expect(log.at(-1)).toMatch(/^! couldn't add friend@example.com to DashyHQ's TestFlight group .*add yourself in App Store Connect/);
    expect(asc.of('betaGroups')).toHaveLength(1);
  });

  it('replaces each app\'s CI App Store profile with a fresh one for the certificate', async () => {
    const asc = fakeAsc({ apps });
    await provision({ api: asc.api, apps, log: () => {} });
    const stale = asc.of('bundleIds')[0]!;
    asc.rows.push({ id: 'stale', type: 'profiles', attributes: { name: profileName(apps[0]), profileType: 'IOS_APP_STORE' }, rel: { bundleId: stale.id } });
    const made = await freshProfiles(asc.api, apps, 'cert-1');
    expect(asc.of('profiles').some((r) => r.id === 'stale')).toBe(false);
    expect(asc.of('profiles').map((r) => [r.attributes.name, r.attributes.profileType, r.rel?.certificate])).toEqual([
      ['DashyHQ CI App Store', 'IOS_APP_STORE', 'cert-1'],
      ['DashyHQ Test CI App Store', 'IOS_APP_STORE', 'cert-1'],
    ]);
    expect(made.map((p: any) => [p.bundleId, p.name])).toEqual([
      ['com.dashyhq.stacks', 'DashyHQ CI App Store'],
      ['com.dashyhq.stacks.test', 'DashyHQ Test CI App Store'],
    ]);
    expect(made.every((p: any) => p.uuid && Buffer.from(p.content, 'base64').toString().startsWith('profile'))).toBe(true);
  });

  it('says to run provisioning first when a bundle ID is missing', async () => {
    await expect(freshProfiles(fakeAsc().api, apps, 'cert-1')).rejects.toThrow(/step 4/);
  });
  it("signs each release with a new certificate, revoking the previous run's, and never yours", async () => {
    const asc = fakeAsc({ apps });
    await provision({ api: asc.api, apps, log: () => {} });
    asc.rows.push({ id: 'yours', type: 'certificates', attributes: { certificateType: 'DISTRIBUTION' } }); // made in Xcode
    const first = await releaseSigning(asc.api, apps, 'CSR 1');
    expect(first.certificate.attributes).toMatchObject({ certificateType: 'DISTRIBUTION', csrContent: 'CSR 1' });
    expect(first.profiles.map((p: any) => p.name)).toEqual(['DashyHQ CI App Store', 'DashyHQ Test CI App Store']);
    // The next run revokes it (Apple has had time to process that run's builds).
    const log: string[] = [];
    const seen: string[] = [];
    const second = await releaseSigning(asc.api, apps, 'CSR 2', { log: (l: string) => log.push(l), onCertificate: (c: any) => seen.push(c.id) });
    expect(log).toContain(`- revoked certificate ${first.certificate.id}, from an earlier run`);
    expect(seen).toEqual([second.certificate.id]);
    expect(asc.of('certificates').map((c) => c.id).sort()).toEqual([second.certificate.id, 'yours'].sort());
    expect(asc.of('profiles').every((p) => p.rel?.certificate === second.certificate.id)).toBe(true);
    // A run that failed before uploading revokes its own.
    expect(await revokeCertificate(asc.api, second.certificate.id)).toBe(true);
    expect(await revokeCertificate(asc.api, second.certificate.id)).toBe(false);
    expect(await leftoverCertificates(asc.api, apps)).toEqual([]);
  });

  it('turns on a capability the app started using since provisioning before making profiles', async () => {
    const asc = fakeAsc({ apps });
    await provision({ api: asc.api, apps, log: () => {} });
    for (const c of asc.of('caps').filter((c) => c.attributes.capabilityType === 'PUSH_NOTIFICATIONS')) asc.rows.splice(asc.rows.indexOf(c), 1);
    const log: string[] = [];
    await releaseSigning(asc.api, apps, 'CSR', { log: (l: string) => log.push(l) });
    expect(log).toContain('+ turned on Push Notifications for com.dashyhq.stacks');
    expect(asc.calls.indexOf('POST /v1/bundleIdCapabilities')).toBeLessThan(asc.calls.lastIndexOf('POST /v1/profiles'));
  });

  it('says what to do when the team has no room for another distribution certificate', async () => {
    const asc = fakeAsc({ apps });
    await provision({ api: asc.api, apps, log: () => {} });
    for (const id of ['a', 'b', 'c']) asc.rows.push({ id, type: 'certificates', attributes: { certificateType: 'DISTRIBUTION' } });
    await expect(releaseSigning(asc.api, apps, 'CSR')).rejects.toThrow(/409[\s\S]*revoke one you don't use/);
    expect(asc.of('certificates')).toHaveLength(3); // yours are never revoked
  });

  it('keeps revoke errors other than "already gone"', async () => {
    const api = async () => {
      throw new Error('DELETE /v1/certificates/x → 403 Forbidden');
    };
    await expect(revokeCertificate(api, 'x')).rejects.toThrow(/403/);
  });
  it('waits for each build to appear, then puts the commit in its TestFlight "What to Test" note', async () => {
    const asc = fakeAsc({ apps: apps.map((a: { bundleId: string; name: string }) => ({ bundleId: a.bundleId, name: a.name })) });
    const [prod, test] = asc.of('apps');
    let polls = 0;
    // Apple lists the builds a little after the upload.
    const sleep = async () => {
      if (++polls === 2) for (const app of [prod!, test!]) asc.rows.push({ id: `build-${app.id}`, type: 'builds', attributes: { version: '4201' }, rel: { app: app.id } });
    };
    const log: string[] = [];
    expect(await noteBuilds(asc.api, apps, 4201, 'Commit 0123abc: Push (#41)', { sleep, log: (l: string) => log.push(l) })).toEqual([]);
    expect(asc.of('notes').map((n) => [n.rel?.build, n.attributes])).toEqual([
      [`build-${prod!.id}`, { locale: 'en-US', whatsNew: 'Commit 0123abc: Push (#41)' }],
      [`build-${test!.id}`, { locale: 'en-US', whatsNew: 'Commit 0123abc: Push (#41)' }],
    ]);
    // A re-run replaces the note rather than adding another.
    await noteBuilds(asc.api, apps, 4201, 'Commit 4567def: Again', { sleep });
    expect(asc.of('notes').map((n) => n.attributes.whatsNew)).toEqual(['Commit 4567def: Again', 'Commit 4567def: Again']);
  });

  it('gives up on a build that never appears, and says which', async () => {
    const asc = fakeAsc({ apps: [{ bundleId: apps[0]!.bundleId, name: apps[0]!.name }] });
    const log: string[] = [];
    const missing = await noteBuilds(asc.api, [apps[0]], 9, 'x', { tries: 3, sleep: async () => {}, log: (l: string) => log.push(l) });
    expect(missing).toEqual([apps[0]]);
    expect(log).toEqual(["! build 9 of DashyHQ didn't appear in App Store Connect"]);
  });
  it('lists in profile-uuids exactly the profiles a release run made, one per line', () => {
    expect(profileUuids([{ uuid: 'A-1' }, { uuid: 'B-2' }])).toBe('A-1\nB-2\n');
    expect(profileUuids([])).toBe('');
  });

});
