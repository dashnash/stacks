import { useEffect } from 'react';
import { ErrorNote, Spinner, timeAgo, useAsync } from '@stacks/web';
import { usePortal } from '../portal';

export function Notifications() {
  const { api, refresh } = usePortal();
  const { data, error } = useAsync(() => api.notifications());
  useEffect(() => {
    if (data?.notifications.some((n) => !n.read)) void api.markRead().then(refresh);
  }, [api, data, refresh]);
  return (
    <section className="card narrow">
      <h1>Inbox</h1>
      {!data ? <Spinner /> : null}
      <ErrorNote error={error} className="error" />
      {data && !data.notifications.length && <p className="muted">Nothing yet.</p>}
      <ul className="list">
        {data?.notifications.map((n) => (
          <li key={n.id} className={n.read ? '' : 'unread'}>
            {n.link ? <a href={n.link}>{n.text}</a> : n.text}
            <span className="muted small"> · {timeAgo(n.at)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
