import { useEffect, useRef, useState } from 'react';
import { ErrorNote, useAsync } from '@stacks/web';
import type { MergePlan } from '../api';
import { loadGoogle, usePortal } from '../portal';

/**
 * Settings › Sign-in methods: the Google accounts that sign in to this Stacks account. Linking one
 * that already has its own Stacks account offers to merge it into this one (spec: Identity v2).
 */
export function SignInMethods() {
  const { api, me, refresh, signInMethod } = usePortal();
  const methods = useAsync(() => api.signInMethods(), [api]);
  const [offer, setOffer] = useState<{ ticket: string; plan: MergePlan } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const link = async (credential: string) => {
    setError(null);
    setNotice(null);
    try {
      const res = await api.linkGoogle(credential);
      if (res.linked) {
        setNotice('Linked. You can sign in with that Google account too.');
        await methods.reload();
      } else setOffer({ ticket: res.ticket, plan: res.plan });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const merge = async () => {
    if (!offer) return;
    setBusy(true);
    setError(null);
    try {
      await api.merge(offer.ticket);
      setOffer(null);
      setNotice('Merged. Everything from the other account is here now.');
      await Promise.all([methods.reload(), refresh()]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!me) return null;
  return (
    <section aria-labelledby="sign-in-methods" className="stack">
      <h2 id="sign-in-methods">Sign-in methods</h2>
      <ul aria-label="Sign-in methods" className="stack plain-list">
        {(methods.data?.identities ?? []).map((m) => (
          <li key={`${m.provider}:${m.sub}`} className="row-gap">
            <span>
              <strong>Google</strong> · {m.email}
              {m.primary && <span className="muted small"> · main (your name and photo come from it)</span>}
            </span>
            {!m.primary && (
              <button
                type="button"
                className="button small secondary"
                aria-label={`Remove ${m.email}`}
                onClick={() =>
                  api
                    .unlink(m)
                    .then(() => methods.reload())
                    .catch((err: Error) => setError(err.message))
                }
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>

      {offer ? (
        <MergeOffer plan={offer.plan} busy={busy} onMerge={merge} onCancel={() => setOffer(null)} />
      ) : (
        <div className="stack">
          <p className="muted small">Link another Google account to sign in with it too. If it already has its own account here, you can merge the two.</p>
          {signInMethod.kind === 'google' ? (
            <GoogleLinkButton onCredential={link} onError={setError} />
          ) : (
            <div className="row-gap">
              {signInMethod.personas
                .filter((p) => p.email !== me.user.email)
                .map((p) => (
                  <button key={p.email} type="button" className="button small secondary" onClick={() => void link(`demo:${p.email}`)}>
                    Link {p.name}'s account (demo)
                  </button>
                ))}
            </div>
          )}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      <ErrorNote error={error} className="error" />
    </section>
  );
}

function MergeOffer({ plan, busy, onMerge, onCancel }: { plan: MergePlan; busy: boolean; onMerge: () => void; onCancel: () => void }) {
  const blocked = plan.problems.length > 0;
  return (
    <div className="card stack" role="region" aria-label="Merge accounts">
      <h3>That Google account already has its own account</h3>
      <p>
        <strong>{plan.other.name}</strong> ({plan.other.email}). Merge it into this one? Its apps, roles, inbox and sign-in move here, and your
        name and photo stay. <strong>This can't be undone.</strong>
      </p>
      {plan.apps.length > 0 && (
        <table className="merge-table">
          <thead>
            <tr>
              <th scope="col">App</th>
              <th scope="col">After the merge</th>
            </tr>
          </thead>
          <tbody>
            {plan.apps.map((a) => (
              <tr key={a.slug}>
                <th scope="row">{a.name}</th>
                <td>{a.result === null ? 'no access' : (a.resultLabel ?? a.result)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {plan.apps.some((a) => a.result === 'BLOCKED') && <p className="muted small">A block on either account stays after a merge.</p>}
      {blocked && (
        <ul className="error">
          {plan.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="row-gap">
        <button type="button" className="button" disabled={busy || blocked} onClick={onMerge}>
          Merge accounts
        </button>
        <button type="button" className="button secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Google's button, in "link" mode: its credential goes to linking, never to signing in. */
function GoogleLinkButton({ onCredential, onError }: { onCredential: (credential: string) => void; onError: (message: string) => void }) {
  const { api } = usePortal();
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [{ googleClientId }] = await Promise.all([api.config(), loadGoogle()]);
      if (cancelled || !window.google || !el.current) return;
      window.google.accounts.id.initialize({ client_id: googleClientId, callback: ({ credential }) => onCredential(credential) });
      window.google.accounts.id.renderButton(el.current, { theme: 'outline', size: 'medium', shape: 'pill', text: 'continue_with' });
    })().catch((err: Error) => onError(err.message));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);
  return <div ref={el} className="google-button" aria-label="Link a Google account" />;
}
