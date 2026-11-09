import { useEffect, useState, type ReactNode } from 'react';
import { Logo } from '../components/Header';
import { PublicHeadliner, PublicShelf } from '../components/PublicShelf';
import { AccountMenu, BuildVersion, useStacks } from '@stacks/web';
import { useApi } from '../lib/auth';
import { useRoute } from '../lib/route';
import type { PublicShelf as PublicShelfData } from '../lib/types';
import { PublicBookView } from './PublicBookView';

/** Links to the privacy policy and terms (static pages in public/), shown on every screen. */
export function LegalLinks() {
  return (
    <footer className="flex flex-wrap gap-x-6 gap-y-1 border-t-2 border-ink px-4 py-4 text-sm text-ink/70 sm:px-6">
      <span>© {new Date().getFullYear()} MOFO Book Klub</span>
      <a href="/privacy.html" className="hover:underline">
        Privacy Policy
      </a>
      <a href="/tos.html" className="hover:underline">
        Terms of Service
      </a>
      <BuildVersion className="font-mono text-xs hover:underline sm:ml-auto" />
    </footer>
  );
}

/** Full-height poster layout shared by the sign-in, pending and loading screens. */
export function Centered({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col">
      <div className="border-b-2 border-ink px-4 py-3 sm:px-6">
        <Logo />
      </div>
      <div className="flex flex-1 items-center px-4 py-10 sm:px-6">
        <div className="w-full max-w-5xl">{children}</div>
      </div>
      <LegalLinks />
    </main>
  );
}

const FEATURES: [string, string][] = [
  [
    'Plan the next meeting',
    'See when and where the Klub meets next, who is leading, and the book everyone is reading.',
  ],
  ['Nominate and vote', 'Suggest books for The Lineup any time and vote for the ones you want to read next.'],
  ['Talk about books', 'Every book and every meeting has its own threaded discussion. Spoilers welcome.'],
  ['Keep the shelf', 'Look back at every book the Klub has read, with covers, details and links to buy them.'],
];

/**
 * Frame for every signed-out page: logo, sign-in at the top right, and the legal links.
 * Opening any signed-out page starts Google sign-in straight away; the button is the fallback.
 */
export function SignedOutLayout({ children }: { children: ReactNode }) {
  const { accessNotice } = useStacks();

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between gap-4 border-b-2 border-ink px-4 py-3 sm:px-6">
        <a href="#/" aria-label="MOFO Book Klub home">
          <Logo />
        </a>
        <div className="flex items-center gap-3">
          <span className="kicker hidden text-ink/60 md:inline">Members</span>
          {/* The platform's account control: one sign-in for every app, straight back here. */}
          <AccountMenu className="klub-account" />
        </div>
      </header>
      {accessNotice && <AccessNotice notice={accessNotice} />}
      <main className="flex-1">{children}</main>
      <LegalLinks />
    </div>
  );
}

/** Signed-out visitors: the home page, or a book's public page (#/book/<isbn>). */
export function SignedOutSite() {
  const route = useRoute();
  return (
    <SignedOutLayout>{route.name === 'book' ? <PublicBookView isbn={route.isbn} /> : <SignInView />}</SignedOutLayout>
  );
}

/**
 * The home page when signed out: what MOFO Book Klub is and does, the current headliner,
 * and the shelf of past books (each opening its public page). Nothing about members.
 * Reachable without signing in (Google's OAuth homepage rules).
 */
export function SignInView() {
  const api = useApi();
  // Public book details only; if they can't load, the page simply goes without them.
  const [shelf, setShelf] = useState<PublicShelfData>({ current: null, books: [] });
  useEffect(() => {
    let cancelled = false;
    api
      .publicShelf()
      .then((r) => !cancelled && setShelf({ current: r.current ?? null, books: r.books ?? [] }))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api]);

  return (
    <>
      <section className="border-b-2 border-ink px-4 py-12 sm:px-6 sm:py-16">
        <p className="kicker">MOFO Book Klub</p>
        <h1 className="display mt-3 text-[clamp(4rem,13vw,10rem)]">
          Read. Dish. <span className="outline-type">Repeat.</span>
        </h1>
        <p className="voice mt-4 max-w-[34ch] text-[clamp(1.6rem,3vw,2.4rem)] leading-[1.05]">
          MOFO Book Klub is where a highly classy group of friends reads about puppets, stuff that puppets do, and stuff
          that people do to puppets.
        </p>
        <p className="mt-5 max-w-[60ch] leading-relaxed text-ink/70">
          Members sign in once with Google for all our apps; we use your name, email and photo only to run your membership — see our{' '}
          <a href="/privacy.html" className="underline decoration-coral decoration-2 underline-offset-2">
            Privacy Policy
          </a>
          .
        </p>
      </section>

      {shelf.current && <PublicHeadliner meetsOn={shelf.current.meetsOn} book={shelf.current.book} />}

      <section aria-label="What it does" className="border-b-2 border-ink px-4 py-12 sm:px-6">
        <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map(([title, text]) => (
            <li key={title} className="border-t-2 border-ink pt-3">
              <h3 className="font-cond text-2xl font-extrabold uppercase leading-none">{title}</h3>
              <p className="mt-2 leading-relaxed text-ink/80">{text}</p>
            </li>
          ))}
        </ul>
      </section>

      <PublicShelf books={shelf.books} />
    </>
  );
}

/** After a sign-in attempt: the platform filed a request for access (private app), or said no. */
export function AccessNotice({ notice }: { notice: string }) {
  return (
    <div role="status" className="border-b-2 border-ink bg-sun px-4 py-4 sm:px-6">
      <p className="kicker">Waiting at the door</p>
      <p className="voice mt-1 text-2xl leading-tight">
        {notice === 'access_pending'
          ? "Your request to join is with the admins. Once someone approves you, you're in."
          : notice === 'access_required'
            ? "You're signed in, but not a member yet. Use Request access at the top right and an admin will let you in."
            : "This account doesn't have access to the Klub."}
      </p>
    </div>
  );
}
