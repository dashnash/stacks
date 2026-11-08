import type { ReactNode } from 'react';
import { Modal } from './ui';

/** A label as it appears in the app, e.g. "Book TBD" on the poster. */
function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="mx-0.5 inline-block whitespace-nowrap rounded-full border-2 border-ink bg-paper px-2 text-xs font-semibold leading-5">
      {children}
    </span>
  );
}

const LINEUP_STEPS: { title: string; text: string; tone: string }[] = [
  { title: 'Nominate', text: 'Anyone adds a book, any time: search by title and/or author, pick the right edition, nominate.', tone: 'bg-sun' },
  {
    title: 'Vote ▲',
    text: 'One vote per book, as many books as you like. Most wanted rises to the top.',
    tone: 'bg-lav',
  },
  {
    title: 'Leader picks',
    text: "The meeting's leader chooses from The Lineup (or any book). It comes off the list.",
    tone: 'bg-coral',
  },
  { title: 'Read & meet', text: 'It headlines the poster until the meeting.', tone: 'bg-white' },
  { title: 'The Shelf', text: 'After the meeting it joins Past headliners.', tone: 'bg-ink text-paper' },
];

const CYCLE_STEPS: { title: string; body: ReactNode; dot: string }[] = [
  {
    title: 'Schedule.',
    body: (
      <>
        The leader sets the date, time and video link. The poster says <Tag>Book TBD</Tag>.
      </>
    ),
    dot: 'bg-sun',
  },
  {
    title: 'Pick the book.',
    body: (
      <>
        The leader chooses from The Lineup. The poster flips to <Tag>Book picked</Tag>.
      </>
    ),
    dot: 'bg-lav',
  },
  { title: 'Meet.', body: 'Join the video call from the poster.', dot: 'bg-coral' },
  {
    title: 'Wrap up & pass the torch.',
    body: (
      <>
        The leader closes the meeting (the book moves to The Shelf) and names who leads next. That person sees{' '}
        <Tag>You&apos;re up!</Tag> and starts again at 1.
      </>
    ),
    dot: 'bg-ink text-paper',
  },
];

/** Schedule → Pick → Meet → Wrap up, round and round. */
function CycleDiagram() {
  const box = (x: number, y: number, w: number, fill: string, title: string, sub: string, light = false) => (
    <g>
      <rect x={x} y={y} width={w} height="60" fill={fill} stroke="#111" strokeWidth="2" />
      <text
        x={x + w / 2}
        y={y + 26}
        textAnchor="middle"
        fontWeight="700"
        fontSize="16"
        fill={light ? '#f6f3ec' : '#111'}
      >
        {title}
      </text>
      <text x={x + w / 2} y={y + 46} textAnchor="middle" fontSize="12" fill={light ? '#ddd' : '#111'}>
        {sub}
      </text>
    </g>
  );
  const arc = (d: string) => <path d={d} fill="none" stroke="#111" strokeWidth="3" markerEnd="url(#help-arrow)" />;
  return (
    <svg
      viewBox="0 0 440 400"
      className="w-full max-w-md font-sans"
      role="img"
      aria-label="The meeting cycle: schedule, pick the book, meet, then wrap up and name the next leader, who starts again"
    >
      <defs>
        <marker id="help-arrow" markerWidth="12" markerHeight="12" refX="9" refY="6" orient="auto">
          <path d="M0,0 L12,6 L0,12 z" fill="#111" />
        </marker>
      </defs>
      {arc('M292,70 Q380,90 388,160')}
      {arc('M388,240 Q380,312 292,330')}
      {arc('M148,330 Q60,312 52,240')}
      {arc('M52,160 Q60,90 148,70')}
      {box(148, 40, 144, 'rgb(var(--c-sun))', '1 · SCHEDULE', 'date + video link')}
      {box(326, 170, 108, 'rgb(var(--c-lav))', '2 · PICK', 'the book')}
      {box(148, 300, 144, 'rgb(var(--c-coral))', '3 · MEET', 'read, dish, repeat')}
      {box(6, 170, 116, '#111', '4 · WRAP UP', 'name next leader', true)}
      <text x="220" y="196" textAnchor="middle" className="font-cond" fontWeight="900" fontSize="32">
        REPEAT
      </text>
      <text x="220" y="222" textAnchor="middle" className="font-serif" fontStyle="italic" fontSize="17">
        new leader each time
      </text>
    </svg>
  );
}

/** "How it works": The Lineup and the meeting cycle, with diagrams. Opened from the header's ? button. */
export function HelpOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="How it works" wide>
      <section aria-labelledby="help-lineup" className="border-b-2 border-ink pb-8">
        <p className="kicker">1 · The Lineup</p>
        <h3 id="help-lineup" className="display mb-6 mt-2 text-[clamp(2rem,5vw,2.8rem)]">
          From idea to <span className="voice text-[0.8em]">headliner</span>
        </h3>
        <ol className="flex flex-col items-stretch md:flex-row">
          {LINEUP_STEPS.map((step, i) => (
            <li key={step.title} className="flex flex-col items-center md:flex-1 md:flex-row">
              <div className={`relative w-full flex-1 self-stretch border-2 border-ink p-3 ${step.tone}`}>
                <span className="absolute -top-3 left-2.5 bg-ink px-1.5 font-cond text-sm font-extrabold text-paper">
                  {i + 1}
                </span>
                <p className="font-cond text-xl font-extrabold uppercase leading-none">{step.title}</p>
                <p className="mt-1.5 text-[0.82rem] leading-snug opacity-80">{step.text}</p>
              </div>
              {i < LINEUP_STEPS.length - 1 && (
                <span aria-hidden className="py-1 font-cond text-2xl font-black md:px-1.5 md:py-0">
                  <span className="md:hidden">↓</span>
                  <span className="hidden md:inline">→</span>
                </span>
              )}
            </li>
          ))}
        </ol>
        <p className="mt-5 max-w-[68ch] text-sm leading-relaxed">
          Changed your mind? <Tag>Withdraw</Tag> your own nomination. You can also <Tag>✎ Edit book</Tag> on a book you
          nominated (details, cover, Amazon link). Votes are a signal, not a ballot: the leader decides.
        </p>
      </section>

      <section aria-labelledby="help-cycle" className="pt-8">
        <p className="kicker">2 · The meeting cycle</p>
        <h3 id="help-cycle" className="display mb-4 mt-2 text-[clamp(2rem,5vw,2.8rem)]">
          Pass the <span className="voice text-[0.8em]">torch</span>
        </h3>
        <div className="grid items-center gap-6 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <CycleDiagram />
          <ol className="space-y-3">
            {CYCLE_STEPS.map((step, i) => (
              <li key={step.title} className="flex gap-3 leading-relaxed">
                <span
                  aria-hidden
                  className={`flex h-7 w-7 flex-none items-center justify-center rounded-full border-2 border-ink font-cond font-extrabold ${step.dot}`}
                >
                  {i + 1}
                </span>
                <p>
                  <strong>{step.title}</strong> {step.body}
                </p>
              </li>
            ))}
          </ol>
        </div>
        <p className="mt-5 text-sm">
          The leader&apos;s controls sit in the yellow strip at the top of the page. Admins can step in at any point.
        </p>
      </section>
    </Modal>
  );
}
