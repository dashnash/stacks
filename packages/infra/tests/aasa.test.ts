import { describe, expect, it } from 'vitest';
import { appleAppSiteAssociation, portalRouterCode, siteRouterCode, type EnvConfig } from '../src/index';

const base: EnvConfig = { rootDomain: 'example.com', hostedZoneId: 'Z1', googleClientId: 'g', platformAdmins: [] };
const withApp: EnvConfig = { ...base, native: { appleTeamId: 'ABCDE12345', iosBundleId: 'com.dashyhq.stacks' } };

/** Run a CloudFront Function's source the way CloudFront would, for one request. */
function run(code: string, uri: string, host = 'hello.example.com') {
  const handler = new Function(`${code}; return handler;`)() as (e: unknown) => any;
  return handler({ request: { uri, headers: { host: { value: host } } } });
}

describe('apple-app-site-association', () => {
  it('is served by the routers as JSON for the app, links everything but sign-in plumbing', () => {
    for (const code of [siteRouterCode(withApp), portalRouterCode('example.com', withApp)]) {
      const res = run(code, '/.well-known/apple-app-site-association', 'auth.example.com');
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type'].value).toBe('application/json');
      const doc = JSON.parse(res.body.data);
      expect(doc.applinks.details[0].appIDs).toEqual(['ABCDE12345.com.dashyhq.stacks']);
      expect(doc.applinks.details[0].components.at(-1)).toEqual({ '/': '*' });
      expect(doc.applinks.details[0].components).toContainEqual({ '/': '/api/*', exclude: true });
    }
    // Everything else routes as before.
    expect(run(siteRouterCode(withApp), '/book/42').uri).toBe('/index.html');
    expect(run(siteRouterCode(withApp), '/assets/a.js').uri).toBe('/assets/a.js');
  });

  it('is not served until the Team ID and bundle ID are set, and rejects a malformed Team ID', () => {
    expect(appleAppSiteAssociation(base)).toBeNull();
    expect(run(siteRouterCode(base), '/.well-known/apple-app-site-association').uri).toBe('/index.html');
    expect(() => appleAppSiteAssociation({ ...base, native: { appleTeamId: 'nope', iosBundleId: 'x' } })).toThrow(/Team ID/);
  });
});
