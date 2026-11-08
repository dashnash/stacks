import { parseManifest } from '@stacks/manifest';
import raw from '../app.manifest.json';

export const manifest = parseManifest(raw, 'apps/__SLUG__/app.manifest.json');
