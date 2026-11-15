import { parseManifest } from '@stacks/manifest';
import raw from '../app.manifest.json';

export const manifest = parseManifest(raw, 'apps/gyro-gym/app.manifest.json');
