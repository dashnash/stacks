import { useState } from 'react';
import { ErrorNote, timeAgo, useAsync } from '@stacks/web';
import { usePortal } from '../portal';
import { canPush, enablePush, pushStatus } from '../push';

/**
 * Settings › Notifications: turn them on for this device (in the iOS app), the devices that get
 * them, and which apps may send them. Muted apps still fill the inbox.
 */
export function NotificationSettings() {
  const { api } = usePortal();
  const devices = useAsync(() => api.devices(), [api]);
  const apps = useAsync(() => api.notificationSettings(), [api]);
  const here = useAsync(() => pushStatus(), []);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = (fn: () => Promise<unknown>) => {
    setError(null);
    setNotice(null);
    fn().catch((err: Error) => setError(err.message));
  };

  const turnOn = () =>
    run(async () => {
      if (await enablePush(api)) setNotice('Notifications are on for this device.');
      else setNotice('Notifications are off in iOS Settings for this app. Turn them on there, then try again.');
      await Promise.all([devices.reload(), here.reload()]);
    });

  const thisDevice = here.data?.deviceId ?? null;
  const registeredHere = !!thisDevice && (devices.data?.devices ?? []).some((d) => d.id === thisDevice);

  return (
    <section aria-labelledby="notification-settings" className="stack">
      <h2 id="notification-settings">Notifications</h2>
      {canPush() ? (
        here.data?.permission === 'granted' && registeredHere ? (
          <p className="muted small">This device gets your notifications.</p>
        ) : here.data?.permission === 'denied' ? (
          <p className="muted small">Notifications are off for this app in iOS Settings › Notifications.</p>
        ) : (
          <div className="row-gap">
            <button type="button" className="button small" onClick={turnOn}>
              Turn on notifications on this device
            </button>
          </div>
        )
      ) : (
        <p className="muted small">Get them on your iPhone or iPad: install the DashyHQ app and sign in.</p>
      )}

      {(devices.data?.devices.length ?? 0) > 0 && (
        <ul aria-label="Devices" className="stack plain-list">
          {devices.data!.devices.map((d) => (
            <li key={d.id} className="row-gap">
              <span>
                <strong>{d.deviceName}</strong>
                {d.id === thisDevice && <span className="muted small"> · this device</span>}
                {d.env === 'sandbox' && <span className="muted small"> · Xcode build</span>}
                <span className="muted small"> · active {timeAgo(d.lastSeenAt)}</span>
              </span>
              <button type="button" className="button small secondary" aria-label={`Remove ${d.deviceName}`} onClick={() => run(async () => (await api.removeDevice(d.id), await devices.reload()))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {(apps.data?.apps.length ?? 0) > 0 && (
        <fieldset className="stack plain-fieldset">
          <legend className="small">Send notifications from</legend>
          {apps.data!.apps.map((a) => (
            <label key={a.slug} className="row-gap tight">
              <input type="checkbox" checked={!a.muted} onChange={(e) => run(async () => (await api.setMuted(a.slug, !e.target.checked), await apps.reload()))} />
              {a.name}
            </label>
          ))}
          <p className="muted small">Turned off, an app's notifications still arrive in your inbox, just not on your devices.</p>
        </fieldset>
      )}
      {notice && <p role="status">{notice}</p>}
      <ErrorNote error={error} className="error" />
    </section>
  );
}
