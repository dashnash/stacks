import { useRef, useState, type PointerEvent, type ReactNode } from 'react';

/** A short swipe right past this share of the row's width toggles done. */
export const SWIPE_DONE = 0.25;
/** A long swipe left past this share of the row's width removes the item. */
export const SWIPE_REMOVE = 0.6;
/** Movement (px) before a press counts as a swipe rather than a tap. */
const SLOP = 8;

type Armed = 'done' | 'remove' | null;

/**
 * A row you can swipe: right toggles done, a long swipe left removes. Pointer events, so it works
 * with a finger (Safari, the iOS shell) and a mouse alike; vertical drags are left to the page
 * (`touch-action: pan-y`). Taps go to the children as normal clicks; a swipe never also clicks.
 */
export function SwipeRow({
  children,
  done,
  onDone,
  onRemove,
}: {
  children: ReactNode;
  done: boolean;
  onDone: () => void;
  onRemove: () => void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const swiping = useRef(false);
  const suppressClick = useRef(false);
  const [dx, setDx] = useState(0);

  const width = () => ref.current?.getBoundingClientRect().width || 320;
  const armed = (x: number): Armed => (x >= width() * SWIPE_DONE ? 'done' : x <= -width() * SWIPE_REMOVE ? 'remove' : null);

  function down(e: PointerEvent<HTMLLIElement>) {
    if (e.button !== 0) return;
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    swiping.current = false;
  }
  function move(e: PointerEvent<HTMLLIElement>) {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    const mx = e.clientX - s.x;
    const my = e.clientY - s.y;
    if (!swiping.current) {
      if (Math.abs(my) > SLOP && Math.abs(my) > Math.abs(mx)) {
        start.current = null; // a scroll, not a swipe
        return;
      }
      if (Math.abs(mx) < SLOP) return;
      swiping.current = true;
      ref.current?.setPointerCapture?.(e.pointerId);
    }
    setDx(mx);
  }
  function up(e: PointerEvent<HTMLLIElement>) {
    const s = start.current;
    start.current = null;
    if (!s || !swiping.current) return;
    swiping.current = false;
    suppressClick.current = true;
    setTimeout(() => (suppressClick.current = false), 0);
    const action = armed(e.clientX - s.x);
    setDx(0);
    if (action === 'done') onDone();
    else if (action === 'remove') onRemove();
  }
  function cancel() {
    start.current = null;
    swiping.current = false;
    setDx(0);
  }

  const state = armed(dx);
  return (
    <li
      ref={ref}
      className={`swipe${done ? ' is-done' : ''}${dx ? ' is-swiping' : ''}`}
      data-armed={state ?? undefined}
      data-dir={dx > 0 ? 'right' : dx < 0 ? 'left' : undefined}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={cancel}
      onClickCapture={(e) => {
        if (suppressClick.current) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
    >
      <div className="swipe-under" aria-hidden="true">
        <span className="under-done">{done ? '↺ Not done' : '✓ Done'}</span>
        <span className="under-remove">Remove 🗑</span>
      </div>
      <div className="swipe-over" style={dx ? { transform: `translateX(${dx}px)` } : undefined}>
        {children}
      </div>
    </li>
  );
}
