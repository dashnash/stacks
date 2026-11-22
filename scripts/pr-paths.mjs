/** Native capabilities whose addition is a platform decision (`SENSITIVE_NATIVE_CAPABILITIES` in @stacks/manifest). */
export const SENSITIVE_NATIVE = ['motion', 'camera', 'microphone', 'location'];

/**
 * Manifest changes that are platform decisions even inside an app folder (spec: Identity v2 and
 * Native capabilities): turning on `needsEmail`, or adding a sensitive `native` capability. `manifests` maps a slug to its manifest before and after the PR
 * (`null` when the file didn't exist). Returns one line per finding.
 */
export function sensitiveManifestChanges(manifests = {}) {
  const found = [];
  for (const [slug, { before, after }] of Object.entries(manifests)) {
    if (after?.needsEmail === true && before?.needsEmail !== true) found.push(`apps/${slug}: turns on "needsEmail" (the app would get people's email addresses)`);
    const had = new Set(Array.isArray(before?.native) ? before.native : []);
    const added = (Array.isArray(after?.native) ? after.native : []).filter((c) => SENSITIVE_NATIVE.includes(c) && !had.has(c));
    for (const c of added) found.push(`apps/${slug}: adds the "${c}" native capability (the iOS app's ${c} sensors)`);
  }
  return found;
}

/**
 * What kind of pull request is this, judged by the files it changes (spec: Guardrails)?
 *
 * - `app/<slug>/…` branches may change only apps/<slug>/ (and package-lock.json).
 * - Any other PR that changes only apps/ is an app PR: it may change one app, never two.
 * - A PR that changes anything outside apps/ is platform work and needs CODEOWNERS review; it may
 *   also touch apps (e.g. an SDK change that updates an app using it).
 * - Turning on a sensitive manifest field (`needsEmail`, a sensitive `native` entry) is platform work wherever it happens, and
 *   an app branch can't do it at all (see sensitiveManifestChanges).
 *
 * Returns { ok, kind: 'app' | 'platform' | 'none', apps, message }.
 */
export function classifyPr(branch, changed, manifests = {}) {
  const sensitive = sensitiveManifestChanges(manifests);
  const result = classifyPaths(branch, changed);
  if (!sensitive.length) return result;
  const why = `Platform decision${sensitive.length > 1 ? 's' : ''} in an app manifest, needs review from the code owners (CODEOWNERS):\n  - ${sensitive.join('\n  - ')}`;
  // An app branch may not make it on its own; any other PR becomes platform work.
  if (result.kind === 'app' && /^app\//.test(branch ?? '')) return { ...result, ok: false, message: `${why}\nOpen it as a platform PR instead of on an app branch.` };
  return { ...result, kind: 'platform', message: result.kind === 'platform' ? `${why}\n${result.message}` : why };
}

function classifyPaths(branch, changed) {
  const files = changed.filter(Boolean);
  const apps = [...new Set(files.filter((f) => f.startsWith('apps/')).map((f) => f.split('/')[1]))].sort();
  const platform = files.filter((f) => !f.startsWith('apps/') && f !== 'package-lock.json');
  const branchApp = /^app\/([a-z][a-z0-9-]+)\//.exec(branch ?? '')?.[1];

  if (branchApp) {
    const outside = files.filter((f) => !f.startsWith(`apps/${branchApp}/`) && f !== 'package-lock.json');
    return outside.length
      ? { ok: false, kind: 'app', apps, message: `App branch for "${branchApp}" changes files outside apps/${branchApp}/:\n  - ${outside.join('\n  - ')}` }
      : { ok: true, kind: 'app', apps, message: `App PR: only apps/${branchApp}/ changed.` };
  }
  if (!platform.length) {
    if (apps.length > 1) return { ok: false, kind: 'app', apps, message: `This PR changes ${apps.length} apps (${apps.join(', ')}). App PRs change one app: split it, one PR per app.` };
    if (apps.length === 1) return { ok: true, kind: 'app', apps, message: `App PR: only apps/${apps[0]}/ changed.` };
    return { ok: true, kind: 'none', apps, message: 'No app or platform files changed.' };
  }
  return {
    ok: true,
    kind: 'platform',
    apps,
    message: `Platform PR (${platform.length} file(s) outside apps/${apps.length ? `, plus apps: ${apps.join(', ')}` : ''}): needs review from the code owners (CODEOWNERS).`,
  };
}

/** Files that never reach a stack: docs/ and Markdown outside an app's folder (apps keep theirs: an app's own files are its deploy). */
export const isDocsFile = (f) => f.startsWith('docs/') || (f.endsWith('.md') && !/^apps\/[^/]+\//.test(f));

const SLUG = /^[a-z][a-z0-9-]*[a-z0-9]$/;

/**
 * What a push to main has to deploy (deploy.yml's `changes` job, spec: Environments and CI/CD), from
 * the files changed since the last green Deploy run. Errs towards `full` whenever in doubt.
 *
 * - `docs`: only docs/ and Markdown outside apps (or nothing): nothing to deploy.
 * - `app`: only apps/<slug>/ (and package-lock.json), for an app that exists on both sides and
 *   isn't on hold anywhere: just that app's stack, in staging then production.
 * - `full`: anything else: the platform and every app. That includes a new or removed app (the
 *   platform's dashboard lists every app), two apps, and an app on hold (the full deploy leaves it out).
 *
 * `appsBefore` / `appsAfter`: the app slugs (folders with app.manifest.json) at the baseline and at
 * the pushed commit. `heldApps`: every environment's holdApps. Returns { mode, app?, reason }.
 */
export function classifyDeploy(changed, { appsBefore = [], appsAfter = [], heldApps = [] } = {}) {
  const files = changed.filter(Boolean);
  const code = files.filter((f) => !isDocsFile(f));
  if (!code.length) return { mode: 'docs', reason: files.length ? `only docs changed (${files.length} file(s))` : 'nothing changed' };
  const paths = classifyPaths(undefined, code);
  if (paths.kind === 'none') return { mode: 'full', reason: 'only package-lock.json changed' };
  if (paths.kind !== 'app' || !paths.ok) return { mode: 'full', reason: paths.kind === 'app' ? `${paths.apps.length} apps changed (${paths.apps.join(', ')})` : `${code.filter((f) => !f.startsWith('apps/') && f !== 'package-lock.json').length} file(s) outside apps/ changed` };
  const [app] = paths.apps;
  if (!SLUG.test(app)) return { mode: 'full', reason: `apps/${app} isn't an app folder` };
  if (!appsAfter.includes(app)) return { mode: 'full', reason: `apps/${app} was removed (the platform lists every app)` };
  if (!appsBefore.includes(app)) return { mode: 'full', reason: `apps/${app} is new (the platform lists every app)` };
  if (heldApps.includes(app)) return { mode: 'full', reason: `${app} is on hold in an environment (the full deploy leaves it out there)` };
  return { mode: 'app', app, reason: `only apps/${app}/ changed` };
}
