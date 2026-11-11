import { useCallback, useEffect, useRef, useState } from 'react';

/** How long the Undo toast stays up. */
export const UNDO_MS = 6000;

export interface UndoAction {
  /** What happened, e.g. "Checked off Milk". */
  label: string;
  /** Put it back exactly as it was. */
  undo: () => Promise<void>;
}

/**
 * One Undo toast at a time: a new action replaces the last one (whose chance to undo is gone).
 * TODO(#45): shake to undo calls `undoLast()` from here once native motion lands.
 */
export function useUndo() {
  const [current, setCurrent] = useState<UndoAction | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);

  const offer = useCallback((action: UndoAction) => {
    clearTimeout(timer.current);
    setCurrent(action);
    timer.current = setTimeout(() => setCurrent(null), UNDO_MS);
  }, []);

  const undoLast = useCallback(async () => {
    if (!current) return;
    clearTimeout(timer.current);
    setBusy(true);
    try {
      await current.undo();
    } finally {
      setBusy(false);
      setCurrent(null);
    }
  }, [current]);

  const dismiss = useCallback(() => {
    clearTimeout(timer.current);
    setCurrent(null);
  }, []);

  return { current, busy, offer, undoLast, dismiss };
}

export function UndoToast({ undo }: { undo: ReturnType<typeof useUndo> }) {
  if (!undo.current) return null;
  return (
    <div className="toast" role="status">
      <span>{undo.current.label}</span>
      <button type="button" className="toast-undo" onClick={() => void undo.undoLast()} disabled={undo.busy}>
        Undo
      </button>
      <button type="button" className="toast-close" aria-label="Dismiss" onClick={undo.dismiss}>
        ✕
      </button>
    </div>
  );
}
