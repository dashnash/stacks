import { BackToKlub } from '../components/BookSpread';
import { Avatar, PanelHeading } from '../components/ui';
import { useApi } from '../lib/auth';
import type { User } from '../lib/types';
import { useAsync } from '../lib/useAsync';

/**
 * Your settings (#/settings). Your name is part of your profile on the platform now, shared by
 * every app, so this page points there.
 */
export function SettingsView({ user }: { user: User }) {
  const api = useApi();
  const portal = useAsync(() => api.portal(), []);
  const profileUrl = portal.data ? `${portal.data.portalUrl.replace(/#\/?$/, '')}#/profile` : undefined;
  return (
    <main>
      <BackToKlub />
      <section className="panel min-h-[60vh]" aria-labelledby="settings-heading">
        <p className="kicker">Your library card</p>
        <PanelHeading id="settings-heading" word="Your" voice="settings" />
        <div className="mt-6 flex items-center gap-4">
          <Avatar person={user} size={56} />
          <div className="min-w-0">
            <p className="truncate font-cond text-3xl font-extrabold uppercase leading-none">{user.name}</p>
            <p className="mt-1 truncate text-sm text-ink/60">{user.email}</p>
          </div>
        </div>
        <p className="mt-10 max-w-md leading-relaxed text-ink/80">
          The name you go by here is set once for all our apps, on your profile. Changes show up the next time you sign in.
        </p>
        <a className="btn-primary mt-5 inline-flex" href={profileUrl ?? '#/settings'} aria-disabled={!profileUrl}>
          Change your name <span aria-hidden>→</span>
        </a>
      </section>
    </main>
  );
}
