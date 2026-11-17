#!/usr/bin/env node
/** CI: fail when a workflow uses an action by tag or branch instead of a commit SHA (#99). Rules in action-pins.mjs. */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { unpinnedActions } from './action-pins.mjs';

const dir = process.argv[2] ?? '.github/workflows';
const files = Object.fromEntries(
  readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => [path.join(dir, f), readFileSync(path.join(dir, f), 'utf8')]),
);
const found = unpinnedActions(files);
if (found.length) {
  console.error(`Unpinned actions:\n  - ${found.join('\n  - ')}`);
  process.exit(1);
}
console.log(`Action pins OK (${Object.keys(files).length} workflows)`);
