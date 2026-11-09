import { useState, type FormEvent } from 'react';
import { fromLocalInputValue, toLocalInputValue } from '../lib/format';
import type { MeetingInput, Person } from '../lib/types';
import { ErrorNote } from './ui';

export function MeetingForm({
  initial,
  members,
  showLeaderPicker,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: Partial<MeetingInput> & { leaderId?: string };
  /** Only needed when `showLeaderPicker` is set (admins). */
  members?: Person[];
  showLeaderPicker?: boolean;
  submitLabel: string;
  onSubmit: (input: MeetingInput) => Promise<void>;
  onCancel?: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [dateTime, setDateTime] = useState(initial?.dateTime ? toLocalInputValue(initial.dateTime) : '');
  const [videoUrl, setVideoUrl] = useState(initial?.videoUrl ?? '');
  const [leaderId, setLeaderId] = useState(initial?.leaderId ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        title: title.trim() || undefined,
        dateTime: fromLocalInputValue(dateTime),
        videoUrl: videoUrl.trim() || undefined,
        ...(showLeaderPicker && leaderId ? { leaderId } : {}),
      });
    } catch (err) {
      setError(err as Error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <label className="label" htmlFor="mf-title">Title</label>
        <input id="mf-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Book Club" />
      </div>
      <div>
        <label className="label" htmlFor="mf-date">Date & time</label>
        <input
          id="mf-date"
          type="datetime-local"
          required
          className="input"
          value={dateTime}
          onChange={(e) => setDateTime(e.target.value)}
        />
      </div>
      <div>
        <label className="label" htmlFor="mf-video">Video link</label>
        <input
          id="mf-video"
          type="url"
          className="input"
          value={videoUrl}
          onChange={(e) => setVideoUrl(e.target.value)}
          placeholder="https://meet.google.com/…"
        />
      </div>
      {showLeaderPicker && (
        <div className="sm:col-span-2">
          <label className="label" htmlFor="mf-leader">Leader</label>
          <select id="mf-leader" className="input" value={leaderId} onChange={(e) => setLeaderId(e.target.value)}>
            <option value="">Me</option>
            {members?.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="sm:col-span-2">
        <ErrorNote error={error} />
      </div>
      <div className="flex justify-end gap-2 sm:col-span-2">
        {onCancel && (
          <button type="button" className="btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn-primary" disabled={saving || !dateTime}>
          {saving ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  );
}
