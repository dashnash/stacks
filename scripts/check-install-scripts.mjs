#!/usr/bin/env node
/** CI: fail when the packages with install scripts change, or a workspace gains one (#104). Rules in install-scripts.mjs. */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { installScriptProblems, workspacePaths } from './install-scripts.mjs';

const root = process.argv[2] ?? '.';
const read = (f) => JSON.parse(readFileSync(path.join(root, f), 'utf8'));
const lock = read('package-lock.json');
const allowlist = read('scripts/install-scripts-allowlist.json');
const manifests = {};
for (const ws of workspacePaths(lock)) {
  const file = path.join(ws, 'package.json');
  if (existsSync(path.join(root, file))) manifests[ws] = read(file);
}
const problems = installScriptProblems(lock, allowlist, manifests);
if (problems.length) {
  console.error(`Install scripts:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(`Install scripts OK (allowlisted: ${Object.keys(allowlist.packages).join(', ')}; ${Object.keys(manifests).length} workspaces checked)`);
