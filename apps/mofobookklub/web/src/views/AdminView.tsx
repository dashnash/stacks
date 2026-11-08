import { isAdmin } from '../lib/types';
import { AdminPanel } from '../components/AdminPanel';
import { AuditLog } from '../components/AuditLog';
import { MeetingActions } from '../components/MeetingActions';
import { PanelHeading } from '../components/ui';
import { useApi } from '../lib/auth';
import { adminHref, HOME_HREF, type AdminTab } from '../lib/route';
import type { AccessPerson } from '../lib/api';
import type { MeetingView, Person, User } from '../lib/types';
import { useAsync } from '../lib/useAsync';

const TABS: [AdminTab, string][] = [
  ['members', 'Members'],
  ['meeting', 'Meeting'],
  ['activity', 'Activity log'],
];

/**
 * The admin page (#/admin): member controls (approvals, roles, removal), the upcoming
 * meeting's controls (so admins can step in), and the activity log of everything people do.
 */
export function AdminView({
  user,
  tab,
  pending,
  onChanged,
  meeting = null,
  nextLeader = null,
}: {
  user: User;
  tab: AdminTab;
  pending: AccessPerson[];
  onChanged: () => Promise<void> | void;
  /** The upcoming meeting, if one is scheduled. */
  meeting?: MeetingView | null;
  /** With no meeting scheduled: who was handed the next one, if anyone. */
  nextLeader?: Person | null;
}) {
  const api = useApi();
  // Everyone the log can be filtered by: members plus people waiting for approval.
  const members = useAsync(() => api.members().then((r) => r.users), []);
  const people = [...(members.data ?? []), ...pending].sort((a, b) => a.name.localeCompare(b.name));

  if (!isAdmin(user)) {
    return (
      <main className="panel min-h-[50vh]">
        <p className="voice text-2xl">Admins only.</p>
        <a href={HOME_HREF} className="kicker mt-4 inline-block hover:text-coral">
          ← Back to the Klub
        </a>
      </main>
    );
  }

  return (
    <main>
      <div className="border-b-2 border-ink px-4 py-3 sm:px-6">
        <a href={HOME_HREF} className="kicker hover:text-coral">
          ← Back to the Klub
        </a>
      </div>
      <section className="panel" aria-labelledby="admin-heading">
        <p className="kicker">Admin</p>
        <PanelHeading id="admin-heading" word="Run the" voice="klub" />
        <div role="tablist" aria-label="Admin sections" className="mb-6 flex flex-wrap gap-2">
          {TABS.map(([id, name]) => (
            <a
              key={id}
              role="tab"
              aria-selected={tab === id}
              href={adminHref(id)}
              className={tab === id ? 'btn-primary !px-4 !py-1.5' : 'btn-ghost !px-4 !py-1.5'}
            >
              {name}
              {id === 'members' && pending.length > 0 && ` · ${pending.length} waiting`}
            </a>
          ))}
        </div>
        <div role="tabpanel" className="max-w-4xl">
          {tab === 'members' ? (
            <AdminPanel
              me={user.email}
              myRole={user.role}
              onChanged={async () => {
                await Promise.all([onChanged(), members.reload()]);
              }}
            />
          ) : tab === 'meeting' ? (
            meeting ? (
              <div className="space-y-3">
                <MeetingActions meeting={meeting} user={user} onChanged={onChanged} variant="panel" />
                <p className="text-sm text-ink/60">
                  The leader has these controls at the top of every page; admins can step in here at any point.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="voice text-2xl">No meeting scheduled.</p>
                <p className="text-ink/70">
                  {nextLeader
                    ? `${nextLeader.name} is up next to schedule it.`
                    : 'Nobody has been handed the next one.'}{' '}
                  Admins can schedule it from the home page.
                </p>
                <a href="#this-month" className="btn-primary inline-flex !px-4 !py-1.5">
                  Schedule the next meeting <span aria-hidden>→</span>
                </a>
              </div>
            )
          ) : (
            <AuditLog people={people} />
          )}
        </div>
      </section>
    </main>
  );
}
