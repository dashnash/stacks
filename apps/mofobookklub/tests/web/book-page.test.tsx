import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installFakeNative } from '@stacks/native';
import { describe, expect, it, vi } from 'vitest';
import { bookChanges } from '../../web/src/components/BookEditor';
import type { BookDetails } from '../../web/src/lib/types';
import { BookView } from '../../web/src/views/BookView';
import { fakeApi, renderWithApi } from './fakes';

const PHM = '9780593135204';

function details(overrides: Partial<BookDetails> = {}): BookDetails {
  return {
    book: {
      isbn: PHM,
      title: 'Project Hail Mary',
      author: 'Andy Weir',
      description: 'A lone astronaut must save the earth.',
      publisher: 'Ballantine Books',
      publishedDate: '2021-05-04',
      pageCount: 496,
      subjects: ['Science fiction', 'Space'],
      amazonUrl: 'https://www.amazon.com/dp/0593135202',
      amazonUrlIsCustom: false,
    },
    nomination: {
      id: 'n1',
      createdAt: '2026-01-01T00:00:00Z',
      nominatedBy: { id: 'marcus@club.test', name: 'Marcus Bell' },
      canWithdraw: false,
      votes: 2,
      myVote: false,
    },
    meetings: [],
    commentCount: 3,
    canEdit: false,
    ...overrides,
  };
}

describe('BookView', () => {
  it('shows the cover, details, a buy button, votes and the discussion', async () => {
    const api = fakeApi({ bookDetails: vi.fn().mockResolvedValue(details()) });
    renderWithApi(<BookView isbn={PHM} />, api);

    expect(await screen.findByRole('heading', { level: 1, name: 'Project Hail Mary' })).toBeInTheDocument();
    expect(screen.getByText('by Andy Weir')).toBeInTheDocument();
    expect(screen.getByText('On The Lineup · nominated by Marcus Bell')).toBeInTheDocument();
    expect(screen.getByText('May 4, 2021')).toBeInTheDocument();
    expect(screen.getByText('496')).toBeInTheDocument();
    expect(screen.getByText('Ballantine Books')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Subjects' })).getAllByRole('listitem')).toHaveLength(2);

    const buy = screen.getByRole('link', { name: 'Buy Project Hail Mary on Amazon (opens in a new tab)' });
    expect(buy).toHaveAttribute('href', 'https://www.amazon.com/dp/0593135202');
    expect(buy).toHaveAttribute('target', '_blank');
    expect(buy).toHaveAttribute('rel', expect.stringContaining('noopener'));

    // Kindle: marked "no deep link", so phones open Amazon's website and not its app.
    const kindle = screen.getByRole('link', {
      name: "Buy Project Hail Mary for Kindle on Amazon's website (opens in a new tab)",
    });
    expect(kindle).toHaveAttribute(
      'href',
      'https://www.amazon.com/s/ref=nodl_kindle?k=Project%20Hail%20Mary%20Andy%20Weir&i=digital-text&nodl=1',
    );
    expect(kindle).toHaveAttribute('target', '_blank');

    // Members can't edit; the book's thread is on the page.
    expect(screen.queryByRole('button', { name: /Edit book/ })).not.toBeInTheDocument();
    await waitFor(() => expect(api.thread).toHaveBeenCalledWith('book', PHM));
  });

  it("titles the app's Share button with the book, and opens a shared comment in its thread", async () => {
    const fake = installFakeNative({ share: () => ({ completed: true }), 'share.page': () => ({}) });
    try {
      const api = fakeApi({
        bookDetails: vi.fn().mockResolvedValue(details()),
        thread: vi.fn().mockResolvedValue({
          comments: [{ id: 'c1', parentId: null, createdAt: '2026-01-01T00:00:00Z', editedAt: null, deleted: false, body: 'Rocky!', author: { id: 'u_a', name: 'Ann' }, canEdit: false, canDelete: false }],
        }),
      });
      renderWithApi(<BookView isbn={PHM} commentId="c1" />, api);
      const c1 = await screen.findByRole('article', { name: 'Comment by Ann' });
      await waitFor(() => expect(c1).toHaveAttribute('data-highlighted', 'true'));
      expect(within(c1).getByRole('button', { name: 'Share' })).toBeInTheDocument();
      await waitFor(() => expect(fake.log.map((l) => l.args)).toContainEqual({ page: window.location.href, title: 'Project Hail Mary · MOFO Book Klub' }));
    } finally {
      fake.remove();
    }
  });

  it('votes from the book page', async () => {
    const api = fakeApi({ bookDetails: vi.fn().mockResolvedValue(details()) });
    const onChanged = vi.fn();
    renderWithApi(<BookView isbn={PHM} onChanged={onChanged} />, api);
    await userEvent.setup().click(await screen.findByRole('button', { name: /^Vote for Project Hail Mary \(2 votes\)/ }));
    expect(api.vote).toHaveBeenCalledWith('n1');
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('says the book is being read, with no vote button, once it is picked', async () => {
    const api = fakeApi({
      bookDetails: vi.fn().mockResolvedValue(
        details({ nomination: null, meetings: [{ id: 'm1', title: 'November Book Klub', dateTime: '2026-11-19T03:00:00Z', status: 'UPCOMING' }] }),
      ),
    });
    renderWithApi(<BookView isbn={PHM} />, api);
    expect(await screen.findByText('Now reading · November Book Klub')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Vote for/ })).not.toBeInTheDocument();
  });

  it('lets admins fix the details, cover and Amazon link', async () => {
    const api = fakeApi({
      bookDetails: vi.fn().mockResolvedValue(details({ canEdit: true })),
      lookUpBook: vi.fn().mockResolvedValue({
        found: { isbn: PHM, title: 'Project Hail Mary: A Novel', author: 'Andy Weir', pageCount: 476 },
        covers: [{ url: 'https://covers.example/big.jpg', width: 1200, source: 'Open Library' }],
      }),
    });
    renderWithApi(<BookView isbn={PHM} />, api);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Edit book/ }));
    const dialog = screen.getByRole('dialog', { name: 'Edit book' });

    await user.clear(within(dialog).getByLabelText('Publisher'));
    await user.type(within(dialog).getByLabelText(/Amazon link/), 'https://www.amazon.com/dp/0593135202?tag=klub');
    await user.click(within(dialog).getByRole('button', { name: 'Find covers & details' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Open Library cover, 1200px wide' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(api.updateBook).toHaveBeenCalledWith(PHM, {
      publisher: null,
      amazonUrl: 'https://www.amazon.com/dp/0593135202?tag=klub',
      coverUrl: 'https://covers.example/big.jpg',
      coverWidth: 1200,
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('bookChanges', () => {
  const base = {
    title: 'Dune',
    author: 'Frank Herbert',
    publisher: 'Chilton',
    publishedDate: '1965',
    pageCount: '412',
    subjects: 'Sci-fi, Desert',
    description: 'Spice.',
    amazonUrl: '',
  };

  it('sends only what changed', () => {
    expect(bookChanges(base, { ...base }, { kind: 'keep' })).toEqual({});
    expect(bookChanges(base, { ...base, subjects: ' Sci-fi ,Desert ' }, { kind: 'keep' })).toEqual({});
    expect(bookChanges(base, { ...base, pageCount: '', subjects: '', title: ' Dune Messiah ' }, { kind: 'none' })).toEqual({
      title: 'Dune Messiah',
      pageCount: null,
      subjects: null,
      coverUrl: null,
    });
  });
});
