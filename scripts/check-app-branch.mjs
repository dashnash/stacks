#!/usr/bin/env node
/**
 * Path guard for app pull requests (spec: Guardrails). A PR from a branch named `app/<slug>/...`
 * may change only apps/<slug>/ (and the lockfile). Usage: check-app-branch <branch> <changed files...>
 * Other branches are platform work and are gated by CODEOWNERS review instead.
 */
const [branch, ...changed] = process.argv.slice(2);
const m = /^app\/([a-z][a-z0-9-]+)\//.exec(branch ?? '');
if (!m) {
  console.log(`${branch}: not an app branch; CODEOWNERS review applies.`);
  process.exit(0);
}
const slug = m[1];
const outside = changed.filter((f) => !f.startsWith(`apps/${slug}/`) && f !== 'package-lock.json');
if (outside.length) {
  console.error(`App branch for "${slug}" changes files outside apps/${slug}/:\n  - ${outside.join('\n  - ')}`);
  process.exit(1);
}
console.log(`App branch OK: only apps/${slug}/ changed.`);
