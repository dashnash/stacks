import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useStacks } from './auth';
import { ApiError } from './client';

/*
 * Headless primitives: behavior and accessibility only. Every element takes `className`/`style`
 * so apps keep full control of the look; nothing here ships a stylesheet.
 */

interface Styled {
  className?: string;
  style?: CSSProperties;
}

/** Initials from words that start with a letter, so "You (Admin)" becomes "YA". */
export function initials(name: string | undefined): string {
  return (
    (name ?? '')
      .split(/\s+/)
      .map((p) => p.match(/\p{L}/u)?.[0] ?? '')
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?'
  );
}

export function Avatar({ person, size = 32, className, style }: Styled & { person?: { name: string; pictureUrl?: string }; size?: number }) {
  if (person?.pictureUrl) {
    return (
      <img
        src={person.pictureUrl}
        alt=""
        width={size}
        height={size}
        referrerPolicy="no-referrer"
        className={className}
        style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', ...style }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={className}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, borderRadius: '50%', fontSize: Math.max(10, size * 0.42), ...style }}
    >
      {initials(person?.name)}
    </span>
  );
}

let scrollLocks = 0;
let savedScroll = 0;

/**
 * Pin the page while a popup is open, so swipes scroll the popup and not the page behind it
 * (iOS Safari ignores overflow:hidden on <body>). Nested popups share one lock. Returns unlock.
 */
export function lockPageScroll(): () => void {
  if (scrollLocks++ === 0) {
    savedScroll = window.scrollY;
    const body = document.body.style;
    body.position = 'fixed';
    body.top = `-${savedScroll}px`;
    body.left = '0';
    body.right = '0';
    body.overflow = 'hidden';
  }
  return () => {
    if (--scrollLocks > 0) return;
    const body = document.body.style;
    body.position = body.top = body.left = body.right = body.overflow = '';
    window.scrollTo(0, savedScroll);
  };
}

/**
 * An accessible dialog rendered at the end of <body>: Escape and a backdrop click close it, focus
 * moves into it, and the page behind stops scrolling. Style the backdrop and panel yourself.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  className,
  style,
  backdropClassName,
  backdropStyle,
}: Styled & {
  open: boolean;
  onClose: () => void;
  /** The dialog's accessible name. */
  title: string;
  children: ReactNode;
  backdropClassName?: string;
  backdropStyle?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => (open ? lockPageScroll() : undefined), [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div
      data-stacks-backdrop=""
      className={backdropClassName}
      style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', ...backdropStyle }}
      onClick={onClose}
    >
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className={className} style={style} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** An error as a line of text. A server failure (500) ends with its ref: "Internal server error (ref 3f9a2c1b)". */
export function ErrorNote({ error, className, style }: Styled & { error?: Error | string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className={className} style={style}>
      {typeof error === 'string' ? error : error.message}
      {error instanceof ApiError && error.ref ? ` (ref ${error.ref})` : ''}
    </p>
  );
}

export function Spinner({ label = 'Loading', className, style }: Styled & { label?: string }) {
  return (
    <div role="status" className={className} style={style}>
      {label}…
    </div>
  );
}

/**
 * Shows what a signed-out or ungranted visitor can do on a private app: sign in (which files an
 * access request when they have no role), or a note that their request is waiting.
 * Render-prop children get the state so apps can draw it their own way.
 */
export function RequestAccess({
  children,
}: {
  children?: (state: { notice: string | null; signIn: () => void; signedIn: boolean }) => ReactNode;
}) {
  const { accessNotice, signIn, status } = useStacks();
  const state = { notice: accessNotice, signIn: () => signIn(), signedIn: status === 'signedIn' };
  if (children) return <>{children(state)}</>;
  if (state.signedIn) return null;
  if (accessNotice === 'access_pending') return <p role="status">Your request for access has been sent. You will get in once someone approves it.</p>;
  if (accessNotice === 'access_required')
    return (
      <button type="button" onClick={state.signIn}>
        Request access
      </button>
    );
  if (accessNotice === 'access_denied') return <p role="status">You don't have access to this app.</p>;
  return (
    <button type="button" onClick={state.signIn}>
      Sign in
    </button>
  );
}
