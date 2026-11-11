import { useState } from 'react';
import { useAsync } from '@stacks/web';
import { usePortal } from '../portal';
import { dismissPrompt, enablePush, promptDismissed, pushStatus } from '../push';

/**
 * In the iOS app, once signed in: offer notifications on the home page (never at launch, never
 * again after "Not now"; Settings › Notifications can still turn them on).
 */
export function PushPrompt() {
  const { api, status } = usePortal();
  const here = useAsync(() => (status === 'signedIn' && !promptDismissed() ? pushStatus() : Promise.resolve(null)), [status]);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (hidden || here.data?.permission !== 'notDetermined') return null;
  const close = () => {
    dismissPrompt();
    setHidden(true);
  };
  return (
    <aside className="notice push-prompt" aria-label="Notifications">
      <span>Get a notification when someone asks for access, or an app has news for you.</span>
      <span className="row-gap tight">
        <button
          type="button"
          className="button small"
          onClick={() =>
            enablePush(api)
              .then(close)
              .catch((err: Error) => setError(err.message))
          }
        >
          Turn on notifications
        </button>
        <button type="button" className="button small secondary" onClick={close}>
          Not now
        </button>
      </span>
      {error && <span className="error small">{error}</span>}
    </aside>
  );
}
