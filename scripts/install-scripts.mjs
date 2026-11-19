/**
 * Rules for check-install-scripts.mjs (#104). Workflows install with `npm ci --ignore-scripts`,
 * so no dependency's install script runs in CI. This keeps the list of packages that have one
 * reviewed: the names with `hasInstallScript: true` in package-lock.json must equal the keys of
 * scripts/install-scripts-allowlist.json, and no workspace may have an install lifecycle script
 * (it would silently stop running under --ignore-scripts).
 */

/** Lifecycle scripts npm runs on install (all skipped by --ignore-scripts). */
export const INSTALL_LIFECYCLE = ['preinstall', 'install', 'postinstall', 'preprepare', 'prepare', 'postprepare'];

/** `node_modules/@scope/pkg`, `packages/x/node_modules/pkg` → the package name (`@scope/pkg`, `pkg`). */
export function packageName(lockPath) {
  const i = lockPath.lastIndexOf('node_modules/');
  return i < 0 ? null : lockPath.slice(i + 'node_modules/'.length);
}

/** Package names with an install script in a lockfile (v2/v3 `packages` map), sorted. */
export function namesWithInstallScripts(lock) {
  const names = new Set();
  for (const [p, entry] of Object.entries(lock.packages ?? {})) {
    const name = packageName(p);
    if (name && entry.hasInstallScript) names.add(name);
  }
  return [...names].sort();
}

/** Workspace folders in a lockfile: entries outside node_modules (the root is ""). */
export function workspacePaths(lock) {
  return Object.keys(lock.packages ?? {}).filter((p) => !p.includes('node_modules/'));
}

/**
 * Problems (empty = OK). `manifests` maps a workspace path ("" for the root) to its package.json.
 */
export function installScriptProblems(lock, allowlist, manifests = {}) {
  const problems = [];
  const found = namesWithInstallScripts(lock);
  const allowed = Object.keys(allowlist.packages ?? {});
  for (const name of found.filter((n) => !allowed.includes(n))) {
    problems.push(`${name} has an install script: review it, then add it to scripts/install-scripts-allowlist.json with the reason`);
  }
  for (const name of allowed.filter((n) => !found.includes(n))) {
    problems.push(`${name} is in scripts/install-scripts-allowlist.json but no longer has an install script in package-lock.json: remove it`);
  }
  for (const [ws, manifest] of Object.entries(manifests)) {
    for (const script of INSTALL_LIFECYCLE) {
      if (manifest?.scripts?.[script]) problems.push(`${ws || 'the root'} package.json has a "${script}" script, which CI never runs (--ignore-scripts)`);
    }
  }
  return problems;
}
