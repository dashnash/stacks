import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { installFakeNative, NativeError } from '@stacks/native';
import { App } from '../src/App';
import { createDemoPortal, DEMO_IOS_BUNDLE_ID } from '../src/demo/backend';
import { PortalProvider } from '../src/portal';

/** The portal as the iOS app shows it: real Google sign-in mode, with the app's bridge on the page. */
function renderInApp(handlers: Parameters<typeof installFakeNative>[0]) {
  const app = installFakeNative(handlers, window as never);
  window.location.hash = '#/signin';
  const { api } = createDemoPortal();
  render(
    <PortalProvider api={api} signInMethod={{ kind: 'google' }}>
      <App />
    </PortalProvider>,
  );
  return app;
}

afterEach(() => {
  delete (window as { stacksNative?: unknown }).stacksNative;
  localStorage.clear();
});

/** A pretend app that does push: permission starts undecided, "Allow" on the system prompt. */
function pushApp(opts: { allow?: boolean } = {}) {
  const state = { permission: 'notDetermined' as 'granted' | 'denied' | 'notDetermined', deviceId: null as string | null, secret: null as string | null, badge: -1 };
  const handlers = {
    'auth.google': () => ({ credential: 'demo:dash@demo.stacks' }),
    'auth.signedOut': () => {
      state.deviceId = null;
      return {};
    },
    'push.status': () => ({ permission: state.permission, deviceId: state.deviceId }),
    'push.register': () => {
      if (opts.allow === false) {
        state.permission = 'denied';
        throw new NativeError('cancelled', 'Notifications are turned off');
      }
      state.permission = 'granted';
      return { token: 'ab'.repeat(32), env: 'production' as const, bundleId: DEMO_IOS_BUNDLE_ID, deviceName: "Dash's iPhone" };
    },
    'push.saveDevice': ({ id, secret }: { id: string; secret: string }) => {
      state.deviceId = id;
      state.secret = secret;
      return {};
    },
    'badge.set': ({ count }: { count: number }) => {
      state.badge = count;
      return {};
    },
  };
  return { state, handlers };
}

async function signInInApp(handlers: Parameters<typeof installFakeNative>[0]) {
  const app = renderInApp(handlers);
  await userEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }));
  await screen.findByRole('button', { name: /Account menu for Dash/ });
  return app;
}

describe('the portal inside the iOS app', () => {
  it("signs in with the app's native Google sign-in, and tells the app when you sign out", async () => {
    const app = renderInApp({ 'auth.google': () => ({ credential: 'demo:sam@demo.stacks' }), 'auth.signedOut': () => ({}) });
    await userEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }));
    const chip = await screen.findByRole('button', { name: /Account menu for Sam/ });
    await userEvent.click(chip);
    await userEvent.click(screen.getByRole('menuitem', { name: /Sign out/ }));
    await waitFor(() => expect(app.log.map((l) => l.name)).toEqual(['auth.google', 'auth.signedOut']));
  });

  it('says nothing when the person backs out of the sign-in sheet', async () => {
    renderInApp({
      'auth.google': () => {
        throw new NativeError('cancelled', 'Cancelled');
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }));
    expect(screen.queryByText(/Cancelled/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeInTheDocument();
  });

  it("links another Google account through the app's sign-in", async () => {
    let next = 'demo:sam@demo.stacks';
    renderInApp({ 'auth.google': () => ({ credential: next }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }));
    await screen.findByRole('button', { name: /Account menu for Sam/ });
    window.location.hash = '#/profile';
    next = 'demo:priya@demo.stacks';
    await userEvent.click(await screen.findByRole('button', { name: 'Link another Google account' }));
    expect(await screen.findByRole('region', { name: 'Merge accounts' })).toHaveTextContent('priya@demo.stacks');
  });

  it('offers notifications on the home page once signed in, registers the device, and hands the app its secret', async () => {
    const { state, handlers } = pushApp();
    const app = await signInInApp(handlers);
    window.location.hash = '#/';
    const prompt = await screen.findByRole('complementary', { name: 'Notifications' });
    await userEvent.click(within(prompt).getByRole('button', { name: 'Turn on notifications' }));
    await waitFor(() => expect(state.deviceId).toBeTruthy());
    expect(state.secret).toMatch(/^sdv_/);
    expect(screen.queryByRole('complementary', { name: 'Notifications' })).not.toBeInTheDocument();
    expect(app.log.map((l) => l.name)).toContain('push.register');

    window.location.hash = '#/profile';
    const devices = await screen.findByRole('list', { name: 'Devices' });
    expect(devices).toHaveTextContent("Dash's iPhone · this device");
    expect(await screen.findByText('This device gets your notifications.')).toBeInTheDocument();
  });

  it('keeps the icon\'s number right: unread plus requests waiting', async () => {
    const { state, handlers } = pushApp();
    await signInInApp(handlers);
    // Dash (demo admin) has requests waiting from the demo data.
    await waitFor(() => expect(state.badge).toBeGreaterThan(0));
  });

  it('never asks again after "Not now", and says where to look when iOS has them off', async () => {
    const { handlers } = pushApp({ allow: false });
    await signInInApp(handlers);
    window.location.hash = '#/';
    await userEvent.click(within(await screen.findByRole('complementary', { name: 'Notifications' })).getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('complementary', { name: 'Notifications' })).not.toBeInTheDocument();

    window.location.hash = '#/profile';
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on notifications on this device' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Notifications are off in iOS Settings');
  });

  it('lets people choose which apps send notifications', async () => {
    const { handlers } = pushApp();
    await signInInApp(handlers);
    window.location.hash = '#/profile';
    const box = await screen.findByRole('checkbox', { name: 'Hello Board' });
    expect(box).toBeChecked();
    await userEvent.click(box);
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Hello Board' })).not.toBeChecked());
  });

  it("shows the app's build and the commit it was built from in the footer", async () => {
    renderInApp({ 'app.info': () => ({ version: '1.0.0', build: '4201', commit: '0123456789abcdef0123456789abcdef01234567', platform: 'ios', protocol: 1 }) });
    expect(await screen.findByText('App 1.0.0 (4201) · 0123456')).toHaveAttribute('title', 'App built from commit 0123456789abcdef0123456789abcdef01234567');
  });

  it('says "local" for a build from Xcode', async () => {
    renderInApp({ 'app.info': () => ({ version: '1.0.0', build: '1', commit: '', platform: 'ios', protocol: 1 }) });
    expect(await screen.findByText('App 1.0.0 (1) · local')).toBeInTheDocument();
  });
});
