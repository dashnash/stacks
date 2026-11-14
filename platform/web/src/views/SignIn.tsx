import { useEffect, useRef, useState } from 'react';
import { getNative, NativeError } from '@stacks/native';
import { ErrorNote, useAsync } from '@stacks/web';
import { appleAvailable, signInWithApple } from '../apple';
import { loadGoogle, safeNext, usePortal } from '../portal';

/** Both sign-in buttons are this wide (px); Google's renders at it, the others match in CSS. */
const SIGNIN_BUTTON_WIDTH = 280;

/** Step 4 of the handshake: sign in, then continue to `next` (back into /authorize) or the catalog. */
export function SignIn({ next }: { next?: string }) {
  const { api, signInMethod, refresh, status } = usePortal();
  const button = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const target = safeNext(next);
  // Inside the iOS app Google's web button can't run (Google blocks embedded browsers): the app signs in natively.
  const inApp = getNative().has('auth.google');
  const config = useAsync(() => (signInMethod.kind === 'google' ? api.config() : Promise.resolve(null)), [api, signInMethod.kind]);
  const showApple = signInMethod.kind === 'google' && appleAvailable(config.data?.appleServicesId);

  const apple = async () => {
    setError(null);
    try {
      const got = await signInWithApple(config.data?.appleServicesId);
      if (!got) return;
      await api.signInWithApple(got.credential, got.name);
      await finish();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const finish = async () => {
    if (target) {
      window.location.assign(target);
      return;
    }
    await refresh();
    window.location.hash = '#/';
  };

  // Already signed in (e.g. came back from another tab): go straight on.
  useEffect(() => {
    if (status === 'signedIn' && target) window.location.assign(target);
  }, [status, target]);

  const signInInApp = async () => {
    setError(null);
    try {
      const { credential } = await getNative().call('auth.google');
      await api.signInWithGoogle(credential);
      await finish();
    } catch (err) {
      if (err instanceof NativeError && err.code === 'cancelled') return;
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    if (signInMethod.kind !== 'google' || inApp) return;
    let cancelled = false;
    (async () => {
      const [{ googleClientId }] = await Promise.all([api.config(), loadGoogle()]);
      if (cancelled || !window.google || !button.current) return;
      window.google.accounts.id.initialize({
        client_id: googleClientId,
        auto_select: true,
        use_fedcm_for_prompt: true,
        callback: ({ credential }) => {
          api
            .signInWithGoogle(credential)
            .then(finish)
            .catch((err: Error) => setError(err.message));
        },
      });
      // Match the page: Google's dark button on a dark page, its outlined one on a light page.
      const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
      // Same size as the Apple button beside it (.signin-option: 280 × 40, pill).
      window.google.accounts.id.renderButton(button.current, { theme: dark ? 'filled_black' : 'outline', size: 'large', shape: 'pill', text: 'continue_with', width: SIGNIN_BUTTON_WIDTH });
      window.google.accounts.id.prompt();
    })().catch((err: Error) => setError(err.message));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, signInMethod.kind]);

  return (
    <section className="card narrow">
      <h1>Sign in</h1>
      <p className="muted">
        {target ? 'Sign in once to open the app. Every other app on this platform will know you too.' : `One ${showApple ? 'Google or Apple' : 'Google'} sign-in for every app here. No new password.`}
      </p>
      {signInMethod.kind === 'google' && (
        // One column, same width and height, same wording ("Continue with …").
        <div className="signin-options">
          {inApp ? (
            <button type="button" className="button signin-option google-option" onClick={() => void signInInApp()}>
              Continue with Google
            </button>
          ) : (
            <div ref={button} className="google-button" />
          )}
          {showApple && (
            <button type="button" className="button signin-option apple-button" onClick={() => void apple()}>
              Continue with Apple
            </button>
          )}
        </div>
      )}
      {signInMethod.kind === 'google' ? null : (
        <div className="stack">
          <p className="muted small">Demo: choose who to be.</p>
          {signInMethod.personas.map((p) => (
            <button
              key={p.email}
              type="button"
              className="button secondary"
              onClick={() =>
                api
                  .signInWithGoogle(`demo:${p.email}`)
                  .then(finish)
                  .catch((err: Error) => setError(err.message))
              }
            >
              Continue as {p.name}
              {p.blurb ? <span className="muted small"> · {p.blurb}</span> : null}
            </button>
          ))}
        </div>
      )}
      <ErrorNote error={error} className="error" />
    </section>
  );
}
