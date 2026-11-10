import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { installFakeNative, NativeError } from '@stacks/native';
import { App } from '../src/App';
import { createDemoPortal } from '../src/demo/backend';
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

afterEach(() => void delete (window as { stacksNative?: unknown }).stacksNative);

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
});
