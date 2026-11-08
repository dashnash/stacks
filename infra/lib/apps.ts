import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parseManifest, type AppManifest } from '@stacks/manifest';

export interface DiscoveredApp {
  manifest: AppManifest;
  dir: string;
}

/** Every `apps/<slug>/app.manifest.json`, validated; the folder name must equal the slug. */
export function discoverApps(repoRoot: string): DiscoveredApp[] {
  const appsDir = path.join(repoRoot, 'apps');
  if (!existsSync(appsDir)) return [];
  return readdirSync(appsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(appsDir, d.name, 'app.manifest.json')))
    .map((d) => {
      const file = path.join(appsDir, d.name, 'app.manifest.json');
      const manifest = parseManifest(JSON.parse(readFileSync(file, 'utf8')), `apps/${d.name}/app.manifest.json`);
      if (manifest.slug !== d.name) throw new Error(`apps/${d.name}: folder name must equal the manifest slug "${manifest.slug}"`);
      return { manifest, dir: path.join(appsDir, d.name) };
    });
}
