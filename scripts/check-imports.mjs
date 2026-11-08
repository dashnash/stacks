#!/usr/bin/env node
/**
 * The monorepo's import rule (spec: Repo layout): code in apps/<slug>/ may import only @stacks/*
 * packages, npm dependencies and files inside its own folder - never another app or platform/.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const appsDir = path.join(root, 'apps');
const problems = [];

function* files(dir) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', 'dist-demo', 'cdk.out'].includes(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* files(full);
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name)) yield full;
  }
}

const importRe = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm;
for (const app of readdirSync(appsDir)) {
  const appDir = path.join(appsDir, app);
  if (!statSync(appDir).isDirectory()) continue;
  for (const file of files(appDir)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(importRe)) {
      const spec = m[1] ?? m[2] ?? m[3];
      const rel = path.relative(root, file);
      if (spec.startsWith('.')) {
        const target = path.resolve(path.dirname(file), spec);
        if (!target.startsWith(appDir + path.sep) && target !== appDir) problems.push(`${rel}: "${spec}" reaches outside apps/${app}/`);
      } else if (spec.startsWith('@stacks-apps/') || spec.startsWith('@stacks/platform')) {
        problems.push(`${rel}: "${spec}" - apps may not import other apps or the platform`);
      }
    }
  }
}
if (problems.length) {
  console.error(`Import rule violations:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log('Import rule OK');
