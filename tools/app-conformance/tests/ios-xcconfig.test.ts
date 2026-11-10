import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain .mjs script, no types
import { reversedClientId, xcconfig } from '../../../scripts/ios-xcconfig.mjs';

const config = {
  environments: {
    production: { rootDomain: 'example.com', googleClientId: 'web.apps.googleusercontent.com', native: { iosBundleId: 'com.x.app', appleTeamId: 'ABCDE12345', googleIosClientIds: ['123-ios.apps.googleusercontent.com'] } },
    staging: { rootDomain: 'test.example.com', googleClientId: 'web.apps.googleusercontent.com', native: { iosBundleId: 'com.x.app.test' } },
  },
};

describe('iOS build settings from stacks.config.json', () => {
  it("writes each environment's domain, bundle ID and Google clients, keeping staging's hosts out of production", () => {
    const prod = xcconfig(config, 'production', '1.2.0');
    expect(prod).toContain('PRODUCT_BUNDLE_IDENTIFIER = com.x.app\n');
    expect(prod).toContain('STACKS_ROOT_DOMAIN = example.com\n');
    expect(prod).toContain('STACKS_OTHER_ROOTS = test.example.com\n');
    expect(prod).toContain('GOOGLE_IOS_CLIENT_ID = 123-ios.apps.googleusercontent.com\n');
    expect(prod).toContain('GOOGLE_REVERSED_CLIENT_ID = com.googleusercontent.apps.123-ios\n');
    expect(prod).toContain('DEVELOPMENT_TEAM = ABCDE12345\n');
    expect(prod).toContain('MARKETING_VERSION = 1.2.0\n');
    const staging = xcconfig(config, 'staging', '1.2.0');
    expect(staging).toContain('APP_DISPLAY_NAME = DashyHQ Test\n');
    expect(staging).toContain('STACKS_OTHER_ROOTS = \n');
    expect(staging).toContain('GOOGLE_REVERSED_CLIENT_ID = com.googleusercontent.apps.unset\n');
    expect(reversedClientId('')).toBe('com.googleusercontent.apps.unset');
  });

  it('refuses values xcconfig would cut short, and a missing bundle ID', () => {
    expect(() => xcconfig({ environments: { production: { ...config.environments.production, googleClientId: 'https://x' } } }, 'production', '1')).toThrow(/"\/\/"/);
    expect(() => xcconfig({ environments: { production: { rootDomain: 'a', googleClientId: 'b' } } }, 'production', '1')).toThrow(/iosBundleId/);
  });

  it('matches the committed files (run node scripts/ios-xcconfig.mjs after changing stacks.config.json)', () => {
    expect(() => execFileSync('node', [join(__dirname, '../../../scripts/ios-xcconfig.mjs'), '--check'], { stdio: 'pipe' })).not.toThrow();
  });
});
