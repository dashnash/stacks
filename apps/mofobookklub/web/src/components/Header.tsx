import { useState, type ReactNode } from 'react';
import { AccountMenu } from '@stacks/web';
import { HelpOverlay } from './HelpOverlay';

export function Logo({ className = 'text-2xl' }: { className?: string }) {
  return (
    <span className={`${className} whitespace-nowrap font-cond font-black uppercase leading-none tracking-tight`}>
      Mofo Book <span className="voice text-[1.15em] text-coral">klub</span>
    </span>
  );
}

/**
 * The site header. Account and sign-in live in the platform's account menu at the top right
 * (your apps, inbox, settings, manage access, sign out).
 */
export function Header({
  pendingCount = 0,
  onAdmin,
  meetingActions,
}: {
  pendingCount?: number;
  onAdmin?: () => void;
  /** Highlighted controls for the viewer's own meeting; inline on wide screens, a second row on phones. */
  meetingActions?: ReactNode;
}) {
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
        <AccountMenu className="klub-account" manageAccessHref="#/admin" />
      </div>
      <HelpOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
    </header>
  );
}
