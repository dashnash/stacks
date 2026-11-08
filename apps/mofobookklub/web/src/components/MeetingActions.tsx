import { isAdmin } from '../lib/types';
import { useState } from 'react';
import { useApi } from '../lib/auth';
import { posterDate } from '../lib/format';
import type { MeetingView, Person, User } from '../lib/types';
import { useAsync } from '../lib/useAsync';
import { ChooseBook } from './ChooseBook';
import { MeetingForm } from './MeetingForm';
import { ErrorNote, Modal } from './ui';

/**
 * A highlighted strip in the header for the current meeting's leader (or whoever is up next
 * to schedule one): who you are to this meeting, the one thing to do next, and the rest.
 * Sits inline on wide screens and as its own row under the logo on phones.
 */
function ActionStrip({ label, detail, children }: { label: string; detail?: string; children: React.ReactNode }) {
  return (
    <section
      aria-label={label}
      className="order-last flex w-full flex-wrap items-center gap-x-3 gap-y-2 border-2 border-ink bg-sun px-3 py-2 shadow-[4px_4px_0_rgb(var(--c-ink))] lg:order-none lg:w-auto lg:py-1.5"
    >
      <span className="flex items-center gap-2">
        {/* A pulsing dot draws the eye; it holds still with reduced motion. */}
        <span aria-hidden className="relative flex h-3 w-3">
          <span className="absolute inline-flex h-full w-full rounded-full bg-coral opacity-75 motion-safe:animate-ping" />
          <span className="relative inline-flex h-3 w-3 rounded-full border-2 border-ink bg-coral" />
        </span>
        <span className="font-cond text-lg font-extrabold uppercase leading-none">{label}</span>
        {detail && <span className="text-sm font-semibold text-ink/70">{detail}</span>}
      </span>
      <span className="flex flex-wrap items-center gap-2">{children}</span>
    </section>
  );
}

/** The same controls as a plain block, for the admin page. */
function ActionPanel({ label, detail, children }: { label: string; detail?: string; children: React.ReactNode }) {
  return (
    <section aria-label={label} className="space-y-3">
      <p className="kicker">
        {label}
        {detail && ` · ${detail}`}
      </p>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </section>
  );
}

/**
 * Controls for the upcoming meeting: in the header for its leader ("strip"), and on the admin
 * page for admins ("panel"), so admins can step in without the header shouting at them.
 */
export function MeetingActions({
  meeting,
  user,
  onChanged,
  variant = 'strip',
}: {
  meeting: MeetingView;
  user: User;
  onChanged: () => Promise<void> | void;
  variant?: 'strip' | 'panel';
}) {
  const api = useApi();
  const [editing, setEditing] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const members = useAsync(() => api.members().then((r) => r.users), []);
  const d = posterDate(meeting.dateTime);
  const leading = user.email === meeting.leaderEmail;
  const Frame = variant === 'panel' ? ActionPanel : ActionStrip;
  const label = variant === 'panel' ? meeting.title : leading ? "You're leading" : 'Admin controls';
  const detail =
    variant === 'panel'
      ? `${d.weekday} ${d.month} ${d.day} · led by ${meeting.leader?.name ?? meeting.leaderEmail}`
      : `${d.weekday} ${d.month} ${d.day}`;

  return (
    <Frame label={label} detail={detail}>
      {meeting.book ? (
        <>
          <button type="button" className="btn-primary !px-4 !py-1.5" onClick={() => setCompleting(true)}>
            Wrap up & pass the torch
          </button>
          <button type="button" className="btn-ghost !px-4 !py-1.5" onClick={() => setChoosing(true)}>
            Change the book
          </button>
        </>
      ) : (
        <button type="button" className="btn-primary !px-4 !py-1.5" onClick={() => setChoosing(true)}>
          Choose the book
        </button>
      )}
      <button type="button" className="btn-ghost !px-4 !py-1.5" onClick={() => setEditing(true)}>
        Edit details
      </button>

      <Modal open={editing} onClose={() => setEditing(false)} title="Edit meeting">
        <MeetingForm
          initial={meeting}
          members={members.data}
          showLeaderPicker={isAdmin(user)}
          submitLabel="Save"
          onCancel={() => setEditing(false)}
          onSubmit={async (input) => {
            // Leaving the picker on "Me" must not reassign an existing leader.
            const { leaderEmail, ...rest } = input;
            await api.updateMeeting(meeting.id, leaderEmail && leaderEmail !== meeting.leaderEmail ? input : rest);
            setEditing(false);
            await onChanged();
          }}
        />
      </Modal>

      <Modal
        open={choosing}
        onClose={() => setChoosing(false)}
        title={meeting.book ? 'Change the book' : 'Choose the book'}
      >
        <ChooseBook
          meeting={meeting}
          onChosen={async () => {
            setChoosing(false);
            await onChanged();
          }}
        />
      </Modal>

      <Modal open={completing} onClose={() => setCompleting(false)} title="Who leads next?">
        <HandOffForm
          members={members.data ?? []}
          onSubmit={async (email) => {
            await api.completeMeeting(meeting.id, email);
            setCompleting(false);
            await onChanged();
          }}
        />
      </Modal>
    </Frame>
  );
}

/** Nothing scheduled, and the viewer is the one who should schedule it. */
export function ScheduleNextAction({ youAreNext }: { youAreNext: boolean }) {
  return (
    <ActionStrip label={youAreNext ? "You're up" : 'No meeting yet'} detail="Schedule the next one">
      <a href="#this-month" className="btn-primary !px-4 !py-1.5">
        Schedule it <span aria-hidden>↓</span>
      </a>
    </ActionStrip>
  );
}

function HandOffForm({ members, onSubmit }: { members: Person[]; onSubmit: (email: string) => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        setError(null);
        try {
          await onSubmit(email);
        } catch (err) {
          setError(err as Error);
        } finally {
          setSaving(false);
        }
      }}
    >
      <p className="voice text-xl leading-snug">
        This moves the meeting onto the shelf. Whoever you pick gets to schedule the next one.
      </p>
      <div>
        <label className="label" htmlFor="next-leader">
          Next leader
        </label>
        <select id="next-leader" className="input" required value={email} onChange={(e) => setEmail(e.target.value)}>
          <option value="" disabled>
            Choose a member…
          </option>
          {members.map((m) => (
            <option key={m.email} value={m.email}>
              {m.name}
            </option>
          ))}
        </select>
      </div>
      <ErrorNote error={error} />
      <div className="flex justify-end">
        <button type="submit" className="btn-accent" disabled={!email || saving}>
          {saving ? 'Saving…' : 'Pass the torch →'}
        </button>
      </div>
    </form>
  );
}
