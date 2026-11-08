import { useEffect, useRef, useState } from 'react';
import { ErrorNote } from '@stacks/web';
import { loadGoogle, safeNext, usePortal } from '../portal';

/** Step 4 of the handshake: sign in, then continue to `next` (back into /authorize) or the catalog. */
export function SignIn({ next }: { next?: string }) {
  const { api, signInMethod, refresh, status } = usePortal();
  const button = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const target = safeNext(next);

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

  useEffect(() => {
    if (signInMethod.kind !== 'google') return;
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
      window.google.accounts.id.renderButton(button.current, { theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with' });
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
      <p className="muted">{target ? 'Sign in once to open the app. Every other app on this platform will know you too.' : 'One Google sign-in for every app here. No new password.'}</p>
      {signInMethod.kind === 'google' ? (
        <div ref={button} className="google-button" />
      ) : (
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
