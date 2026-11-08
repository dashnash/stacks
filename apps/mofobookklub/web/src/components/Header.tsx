import { useState, type ReactNode } from 'react';
import { SETTINGS_HREF } from '../lib/route';
import type { User } from '../lib/types';
import { HelpOverlay } from './HelpOverlay';
import { Avatar } from './ui';

export function Logo({ className = 'text-2xl' }: { className?: string }) {
  return (
    <span className={`${className} whitespace-nowrap font-cond font-black uppercase leading-none tracking-tight`}>
      Mofo Book <span className="voice text-[1.15em] text-coral">klub</span>
    </span>
  );
}

export function Header({
  user,
  onSignOut,
  pendingCount = 0,
  onAdmin,
  meetingActions,
}: {
  user: User;
  onSignOut: () => void;
  pendingCount?: number;
  onAdmin?: () => void;
  /** Highlighted controls for the viewer's own meeting; inline on wide screens, a second row on phones. */
  meetingActions?: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  return (
    <header className="app-header sticky top-0 z-30 border-b-2 border-ink bg-paper">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 sm:gap-5 sm:px-6">
        <Logo />
        <nav aria-label="Sections" className="hidden gap-5 text-sm font-semibold md:flex">
          <a href="#this-month" className="hover:underline">
            This month
          </a>
          <a href="#shelf" className="hover:underline">
            Shelf
          </a>
        </nav>
        {meetingActions}
        <span className="flex-1" />
        <button
          type="button"
          className="btn-ghost h-10 w-10 !p-0 font-cond text-xl font-black"
          onClick={() => setHelpOpen(true)}
          aria-label="How it works"
          title="How it works"
        >
          ?
        </button>
        {onAdmin && (
          <button type="button" className="btn-ghost relative !px-4 !py-1.5" onClick={onAdmin}>
            Admin
            {pendingCount > 0 && (
              <span className="absolute -right-2 -top-2 min-w-[22px] rounded-full border-2 border-ink bg-coral px-1 text-[11px] font-bold leading-[18px] text-ink">
                {pendingCount}
              </span>
            )}
          </button>
        )}
        <div className="relative">
          <button
            type="button"
            className="btn-ghost !gap-2 !py-1 !pl-1 !pr-1 sm:!pr-4"
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="Account menu"
            aria-expanded={menuOpen}
          >
            <Avatar person={user} size={30} />
            <span className="hidden sm:inline">{user.name}</span>
          </button>
          {menuOpen && (
            <div className="absolute right-0 mt-2 w-64 border-2 border-ink bg-paper p-4 shadow-[6px_6px_0_rgb(var(--c-ink))]">
              <p className="truncate font-cond text-2xl font-extrabold uppercase leading-none">{user.name}</p>
              <p className="mt-1 truncate text-xs text-ink/60">{user.email}</p>
              <a href={SETTINGS_HREF} className="btn-ghost mt-4 w-full" onClick={() => setMenuOpen(false)}>
                Settings
              </a>
              <button type="button" className="btn-primary mt-2 w-full" onClick={onSignOut}>
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
      <HelpOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
    </header>
  );
}
