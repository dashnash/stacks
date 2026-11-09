/**
 * What kind of pull request is this, judged by the files it changes (spec: Guardrails)?
 *
 * - `app/<slug>/…` branches may change only apps/<slug>/ (and package-lock.json).
 * - Any other PR that changes only apps/ is an app PR: it may change one app, never two.
 * - A PR that changes anything outside apps/ is platform work and needs CODEOWNERS review; it may
 *   also touch apps (e.g. an SDK change that updates an app using it).
 *
 * Returns { ok, kind: 'app' | 'platform' | 'none', apps, message }.
 */
export function classifyPr(branch, changed) {
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
