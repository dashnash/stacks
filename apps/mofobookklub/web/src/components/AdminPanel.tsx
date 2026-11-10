import { useState } from 'react';
import { useApi } from '../lib/auth';
import { formatShortDate } from '../lib/format';
import type { Role } from '../lib/types';
import { useAsync } from '../lib/useAsync';
import { Avatar, ErrorNote } from './ui';

/**
 * Members and requests to join. Access lives on the platform: these buttons change the same grants
 * as the portal's access grid, under the same rules (only owners make or remove admins).
 */
export function AdminPanel({
  onChanged,
  me,
  myRole = 'ADMIN',
}: {
  onChanged: () => Promise<void> | void;
  /** The signed-in admin, who can't remove themselves. */
  me?: string;
  /** Only the owner can make or unmake admins, or remove one. */
  myRole?: Role;
}) {
  const isOwner = myRole === 'OWNER';
  const api = useApi();
  const access = useAsync(() => api.access(), []);
  const members = { data: access.data?.members, error: access.error };
  const pending = access.data?.pending ?? [];
  const blocked = access.data?.blocked ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  async function act(userId: string, action: () => Promise<unknown>) {
    setBusy(userId);
    setError(null);
    try {
      await action();
      await Promise.all([onChanged(), access.reload()]);
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <p className="kicker">Waiting at the door · {pending.length}</p>
      <ErrorNote error={error} />
      {pending.length === 0 && <p className="voice text-2xl">Nobody is waiting. The velvet rope holds.</p>}
      <ul>
        {pending.map((u) => (
          <li key={u.id} className="flex flex-wrap items-center gap-3 border-t-2 border-ink py-3 last:border-b-2">
            <Avatar person={u} size={40} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-cond text-2xl font-extrabold uppercase leading-none">{u.name}</p>
              <p className="truncate text-xs text-ink/60">
                {u.email}
                {u.requestedAt ? ` · asked ${formatShortDate(u.requestedAt)}` : ''}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-ghost !px-4 !py-1.5"
                disabled={busy !== null}
                onClick={() => act(u.id, () => api.setAccess(u.id, 'BLOCKED'))}
                title="Turn them away and stop further requests"
              >
                Block
              </button>
              <button
                type="button"
                className="btn-ghost !px-4 !py-1.5"
                disabled={busy !== null}
                onClick={() => act(u.id, () => api.setAccess(u.id, null))}
              >
                Dismiss
              </button>
              <button
                type="button"
                className="btn-accent !px-4 !py-1.5"
                disabled={busy !== null}
                onClick={() => act(u.id, () => api.setAccess(u.id, 'MEMBER'))}
              >
                Approve
              </button>
            </div>
          </li>
        ))}
      </ul>

      <p className="kicker pt-4">Members · {members.data?.length ?? '…'}</p>
      <ErrorNote error={members.error} />
      <ul aria-label="Members">
        {(members.data ?? []).map((u) => (
          <li key={u.id} className="flex flex-wrap items-center gap-3 border-t-2 border-ink py-3 last:border-b-2">
            <Avatar person={u} size={32} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold leading-tight">
                {u.name}
                {u.role === 'OWNER' && <span className="kicker ml-2 text-coral">Owner</span>}
                {u.role === 'ADMIN' && <span className="kicker ml-2 text-coral">Admin</span>}
              </p>
              <p className="truncate text-xs text-ink/60">{u.email}</p>
            </div>
            {/* Roles: only owners make or remove admins (the platform enforces it too). */}
            {isOwner && u.id !== me && u.role !== 'OWNER' && confirming !== u.id && (
              <button
                type="button"
                className="btn-ghost !px-3 !py-1"
                disabled={busy !== null}
                onClick={() => act(u.id, () => api.setAccess(u.id, u.role === 'ADMIN' ? 'MEMBER' : 'ADMIN'))}
              >
                {u.role === 'ADMIN' ? 'Make member' : 'Make admin'}
              </button>
            )}
            {u.id !== me &&
              u.role !== 'OWNER' &&
              (u.role !== 'ADMIN' || isOwner) &&
              (confirming === u.id ? (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-ink/70">Remove {u.name}?</span>
                  <button
                    type="button"
                    className="btn-ghost !px-3 !py-1"
                    disabled={busy !== null}
                    onClick={() => setConfirming(null)}
                  >
                    Keep
                  </button>
                  <button
                    type="button"
                    className="btn-accent !px-3 !py-1"
                    disabled={busy !== null}
                    onClick={() =>
                      act(u.id, async () => {
                        await api.setAccess(u.id, null);
                        setConfirming(null);
                      })
                    }
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="btn-ghost !px-3 !py-1"
                  disabled={busy !== null}
                  onClick={() => setConfirming(u.id)}
                  aria-label={`Remove ${u.name}`}
                >
                  Remove
                </button>
              ))}
          </li>
        ))}
      </ul>
      {blocked.length > 0 && (
        <>
          <p className="kicker pt-4">Blocked · {blocked.length}</p>
          <ul aria-label="Blocked">
            {blocked.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center gap-3 border-t-2 border-ink py-3 last:border-b-2">
                <Avatar person={u} size={32} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold leading-tight">{u.name}</p>
                  <p className="truncate text-xs text-ink/60">{u.email}</p>
                </div>
                <button type="button" className="btn-ghost !px-4 !py-1.5" disabled={busy !== null} onClick={() => act(u.id, () => api.setAccess(u.id, null))}>
                  Unblock
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="text-xs text-ink/60">
        Blocked people can't ask to join again until someone unblocks them. Removed people lose access straight away, in this app and the portal. Their comments, nominations and votes
        stay, credited to “Former member”. If they sign in again they ask for access like anyone new.
        {isOwner
          ? ' As the owner, you can also make people admins, and remove admins.'
          : ' Only owners can make people admins or remove admins.'}
        {' '}Everyone's access across all apps is also on the platform's access page.
      </p>
    </div>
  );
}
