#!/usr/bin/env node
/**
 * CI path guard (spec: Guardrails). Usage: check-app-branch <branch> <changed files...>
 * The rules are in pr-paths.mjs (tested in tools/app-conformance).
 */
import { classifyPr } from './pr-paths.mjs';

const [branch, ...changed] = process.argv.slice(2);
const result = classifyPr(branch, changed);
(result.ok ? console.log : console.error)(result.message);
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### PR paths\n\n${result.ok ? '✅' : '❌'} ${result.message.replace(/\n/g, '  \n')}\n`);
}
process.exit(result.ok ? 0 : 1);
