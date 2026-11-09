import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BookHistory } from '../../web/src/components/BookHistory';
import { QuoteBand } from '../../web/src/components/QuoteBand';
import { NextMeetingHero } from '../../web/src/components/NextMeetingHero';
import { LineupPanel } from '../../web/src/components/LineupPanel';
import { BookCover } from '../../web/src/components/ui';
import { MeetingActions, ScheduleNextAction } from '../../web/src/components/MeetingActions';
import type { PastMeeting } from '../../web/src/lib/types';
import { admin, books, fakeApi, lineupOf, meeting, member, renderWithApi } from './fakes';

describe('QuoteBand', () => {
  it('shows a critic quote and swaps it for a different one', async () => {
    const randomEasterEgg = vi
      .fn()
      .mockResolvedValueOnce({ id: 'e1', quote: 'A caterpillar critique.', imageUrl: 'https://img/gary.jpg' })
      .mockResolvedValueOnce({ id: 'e2', quote: 'Moby Dick is about tax law.', imageUrl: null });
    renderWithApi(<QuoteBand />, fakeApi({ randomEasterEgg }));

    expect(await screen.findByText(/A caterpillar critique\./)).toBeInTheDocument();
    // Quotes are unsigned: a face, but no critic's name.
    expect(screen.queryByText(/^—/)).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'One of our critics' })).toHaveAttribute('src', 'https://img/gary.jpg');

    await userEvent.setup().click(screen.getByRole('button', { name: /Another one/ }));
    expect(await screen.findByText(/Moby Dick is about tax law\./)).toBeInTheDocument();
    expect(randomEasterEgg).toHaveBeenLastCalledWith('e1');
    // No photo for this one, so a decorative silhouette stands in.
    expect(screen.queryByRole('img', { name: 'One of our critics' })).not.toBeInTheDocument();
  });

  it('renders nothing when no quotes have been seeded', async () => {
    const randomEasterEgg = vi.fn().mockRejectedValue(new Error('No easter eggs have been seeded yet'));
    const { container } = renderWithApi(<QuoteBand />, fakeApi({ randomEasterEgg }));
    await waitFor(() => expect(randomEasterEgg).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});

describe('BookCover', () => {
  it('falls back to the typeset cover when the image fails to load', () => {
    renderWithApi(<BookCover book={{ ...books[1]!, coverUrl: 'https://covers.example/missing.jpg' }} />);
    const img = screen.getByRole('img', { name: 'Cover of Dune' });
    expect(img.tagName).toBe('IMG');
    fireEvent.error(img);
    const fallback = screen.getByRole('img', { name: 'Cover of Dune' });
    expect(fallback.tagName).toBe('DIV');
    expect(fallback).toHaveTextContent('Dune');
  });
});

describe('BookHistory', () => {
  const past = (id: string, dateTime: string, title: string): PastMeeting => ({
    ...meeting({ id, dateTime }),
    status: 'PAST',
    phase: 'PAST',
    book: { isbn: '978000000000' + id, title, author: 'Someone' },
  });

  it('filters the shelf by year', async () => {
    renderWithApi(
      <BookHistory
        meetings={[past('1', '2026-03-01T12:00:00Z', 'Dune'), past('2', '2025-06-01T12:00:00Z', 'Emma')]}
      />,
    );
    expect(screen.getByRole('img', { name: 'Cover of Dune' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Cover of Emma' })).toBeInTheDocument();

    await userEvent.setup().selectOptions(screen.getByLabelText('Filter by year'), '2025');
    expect(screen.queryByRole('img', { name: 'Cover of Dune' })).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Cover of Emma' })).toBeInTheDocument();
  });

  it('shows each book as a card with its cover, title, author and leader', () => {
    renderWithApi(<BookHistory meetings={[past('1', '2026-03-01T12:00:00Z', 'Dune')]} />);
    expect(screen.getByRole('img', { name: 'Cover of Dune' })).toBeInTheDocument();
    expect(screen.getByText('Dune', { selector: '.lift-title' })).toBeInTheDocument();
    expect(screen.getByText('Someone', { selector: 'p.voice' })).toBeInTheDocument();
    expect(screen.getByText(/led by Jane Doe/)).toBeInTheDocument();
    // The details slide in on hover; the title links to the book's page and covers the whole card.
    const card = screen.getByRole('img', { name: 'Cover of Dune' }).closest('li')!;
    expect(screen.getByRole('link', { name: 'Dune' })).toHaveAttribute('href', '#/book/9780000000001');
    expect(screen.getByRole('link', { name: 'Dune' })).toHaveClass('stretched-link');
    expect(card.querySelector('.reveal-panel')).toHaveTextContent(/Dune.*Someone.*led by Jane Doe/);
  });

  it('has an empty state', () => {
    renderWithApi(<BookHistory meetings={[]} />);
    expect(screen.getByText(/No books on the shelf yet/)).toBeInTheDocument();
  });
});

describe('NextMeetingHero', () => {
  it('shows the leader, the video link and the active book, with no controls of its own', () => {
    renderWithApi(<NextMeetingHero meeting={meeting({ phase: 'SELECTED', book: books[0], bookIsbn: books[0]!.isbn, canManage: true })} />);
    // The date is the headline: THU/FRI etc. depend on the test machine's time zone, so check the day number.
    const day = String(new Date('2026-10-24T02:00:00.000Z').getDate());
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(new RegExp(`\\b${day}$`));
    expect(screen.getAllByText('Jane Doe').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /Join the video call/ })).toHaveAttribute('href', 'https://meet.google.com/abc');
    expect(screen.getAllByText('Project Hail Mary').length).toBeGreaterThan(0);
    expect(screen.getByText('by Andy Weir')).toBeInTheDocument();
    // Meeting controls live in the header now; the poster only offers the discussions.
    expect(screen.queryByRole('button', { name: /Choose the book|Wrap up|Edit details/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Meeting chat/ })).toBeInTheDocument();
  });

  it("puts the chosen book's full-size cover on the poster, with the shelf's hover details", () => {
    const book = { ...books[0]!, coverUrl: 'https://covers.example/phm-large.jpg', coverWidth: 1200 };
    const m = meeting({ phase: 'SELECTED', book, bookIsbn: book.isbn, nominatedBy: { email: 'm@x', name: 'Marcus Bell' } });
    renderWithApi(<NextMeetingHero meeting={m} />);
    const cover = screen.getByRole('img', { name: 'Cover of Project Hail Mary' });
    expect(cover).toHaveAttribute('src', 'https://covers.example/phm-large.jpg');
    expect(cover).toHaveAttribute('loading', 'eager');
    expect(screen.getByText('Now reading')).toBeInTheDocument();
    // The line under the date is just the time and the host; the book is shown elsewhere.
    expect(screen.getByText('Host:')).toBeInTheDocument();
    expect(screen.getByText('Jane Doe', { selector: 'mark' })).toBeInTheDocument();
    expect(screen.queryByText(/we're reading/)).not.toBeInTheDocument();
    const card = cover.closest('.reveal-card')!;
    // The title links to the book's page, which is also how keyboards reach the hover details.
    expect(screen.getByRole('link', { name: 'Project Hail Mary' })).toHaveAttribute('href', '#/book/9780593135204');
    expect(card).not.toHaveAttribute('tabindex');
    expect(card.querySelector('.reveal-panel')).toHaveTextContent(/Project Hail Mary.*Andy Weir.*led by Jane Doe · nominated by Marcus Bell/);
  });

  it('shows no cover before a book is picked', () => {
    renderWithApi(<NextMeetingHero meeting={meeting({ phase: 'PLANNING' })} />);
    expect(screen.queryByRole('img', { name: /Cover of/ })).not.toBeInTheDocument();
  });
});

describe('MeetingActions (header strip)', () => {
  it("tells the leader they're leading and leads with choosing the book from The Lineup", async () => {
    const api = fakeApi({ lineup: vi.fn().mockResolvedValue(lineupOf(books.slice(0, 2), { canPick: true, meetingId: 'm1' })) });
    const onChanged = vi.fn();
    const m = meeting({ canManage: true, leaderEmail: member.email });
    renderWithApi(<MeetingActions meeting={m} user={member} onChanged={onChanged} />, api);
    const user = userEvent.setup();

    const strip = screen.getByRole('region', { name: "You're leading" });
    expect(within(strip).queryByRole('button', { name: /Wrap up/ })).not.toBeInTheDocument();
    await user.click(within(strip).getByRole('button', { name: 'Choose the book' }));
    const dialog = await screen.findByRole('dialog', { name: 'Choose the book' });
    expect(await within(dialog).findByRole('img', { name: 'Cover of Dune' })).toBeInTheDocument();
    await user.click(within(dialog).getAllByRole('button', { name: 'Pick this one' })[1]!);
    expect(api.chooseBook).toHaveBeenCalledWith('m1', { nominationId: 'n1' });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('offers wrap-up and changing the book once one is picked, and labels admins who are not leading', () => {
    const m = meeting({ canManage: true, phase: 'SELECTED', book: books[0], bookIsbn: books[0]!.isbn });
    renderWithApi(<MeetingActions meeting={m} user={admin} onChanged={() => {}} />);
    const strip = screen.getByRole('region', { name: 'Admin controls' });
    expect(within(strip).getByRole('button', { name: /Wrap up/ })).toBeInTheDocument();
    expect(within(strip).getByRole('button', { name: 'Change the book' })).toBeInTheDocument();
    expect(within(strip).getByRole('button', { name: 'Edit details' })).toBeInTheDocument();
  });

  it("points the handed-off leader at the scheduling form", () => {
    renderWithApi(<ScheduleNextAction youAreNext />);
    expect(within(screen.getByRole('region', { name: "You're up" })).getByRole('link', { name: /Schedule it/ })).toHaveAttribute(
      'href',
      '#this-month',
    );
  });
});

describe('LineupPanel', () => {
  it('shows each nomination as a card with its cover, and nominates from search', async () => {
    const api = fakeApi({
      searchEditions: vi.fn().mockResolvedValue({ editions: [{ ...books[2]!, source: 'Google Books' }] }),
      bookDetails: vi.fn().mockResolvedValue({ book: books[2], canEdit: false }),
    });
    const onChanged = vi.fn();
    const withCover = { ...books[0]!, coverUrl: 'https://covers.example/phm.jpg' };
    renderWithApi(<LineupPanel lineup={lineupOf([withCover, books[1]!])} onChanged={onChanged} />, api);
    const user = userEvent.setup();

    const cards = within(screen.getByRole('list', { name: 'The Lineup' })).getAllByRole('listitem');
    expect(cards).toHaveLength(2);
    expect(within(cards[0]!).getByRole('img', { name: 'Cover of Project Hail Mary' })).toHaveAttribute('src', 'https://covers.example/phm.jpg');
    expect(within(cards[0]!).getByText('nominated by Marcus Bell')).toBeInTheDocument();
    // Members who can't pick or withdraw only get vote and discuss buttons.
    expect(within(cards[0]!).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Vote for Project Hail Mary (0 votes)',
      'Discuss (0 comments)',
    ]);

    await user.type(screen.getByLabelText(/Search by title/), 'hobbit');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.click(await screen.findByRole('button', { name: /^Choose/ }));
    await user.click(screen.getByRole('button', { name: 'Nominate' }));
    expect(api.nominate).toHaveBeenCalledWith('9780547928227');
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('offers withdraw on your own nominations and pick buttons to the leader', async () => {
    const api = fakeApi();
    const onPick = vi.fn().mockResolvedValue(undefined);
    renderWithApi(
      <LineupPanel lineup={lineupOf([books[0]!], { canWithdraw: true })} meetingTitle="October" onChanged={() => {}} onPick={onPick} />,
      api,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Pick for October' }));
    expect(onPick).toHaveBeenCalledWith('n0');
    await user.click(screen.getByRole('button', { name: 'Withdraw' }));
    expect(api.withdrawNomination).toHaveBeenCalledWith('n0');
  });
});
