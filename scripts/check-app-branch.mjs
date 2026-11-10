#!/usr/bin/env node
/**
 * CI path guard (spec: Guardrails). Usage: check-app-branch <branch> <changed files...>
 * The rules are in pr-paths.mjs (tested in tools/app-conformance).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { classifyPr } from './pr-paths.mjs';

const [branch, ...changed] = process.argv.slice(2);
// Changed manifests, before (at BASE_SHA) and after (the checkout), for the sensitive-field check.
const read = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const manifests = {};
for (const file of changed.filter((f) => /^apps\/[^/]+\/app\.manifest\.json$/.test(f))) {
  const slug = file.split('/')[1];
  let before = null;
  if (process.env.BASE_SHA) {
    try {
      before = read(execFileSync('git', ['show', `${process.env.BASE_SHA}:${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    } catch {
      before = null; // a new app
    }
  }
  manifests[slug] = { before, after: existsSync(file) ? read(readFileSync(file, 'utf8')) : null };
}
const result = classifyPr(branch, changed, manifests);
(result.ok ? console.log : console.error)(result.message);
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### PR paths\n\n${result.ok ? '✅' : '❌'} ${result.message.replace(/\n/g, '  \n')}\n`);
}
process.exit(result.ok ? 0 : 1);
