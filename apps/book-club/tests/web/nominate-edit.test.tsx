import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BookEditor } from '../../web/src/components/BookEditor';
import { LineupPanel } from '../../web/src/components/LineupPanel';
import { Modal } from '../../web/src/components/ui';
import type { BookPageBook } from '../../web/src/lib/types';
import { fakeApi, lineupOf, renderWithApi } from './fakes';

const dune: BookPageBook = {
  isbn: '9780441172719',
  title: 'Dune',
  author: 'Frank Herbert',
  amazonUrl: 'https://www.amazon.com/dp/0441172717',
  amazonUrlIsCustom: false,
};

describe('book editor layout', () => {
  it('puts the cover and lookup controls above the detail fields', () => {
    renderWithApi(<BookEditor book={dune} onClose={() => {}} onSaved={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'Edit book' });
    const findButton = within(dialog).getByRole('button', { name: 'Find covers & details' });
    const titleField = within(dialog).getByLabelText('Title');
    expect(findButton.compareDocumentPosition(titleField) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('searching other editions', () => {
  it("searches with your own words, then uses an edition's cover and details", async () => {
    const api = fakeApi({
      lookUpBook: vi.fn(async (_isbn: string, q?: string) => ({
        found: null,
        covers: [],
        editions: q
          ? [
              {
                title: 'Dune (Deluxe Edition)',
                author: 'Frank Herbert',
                isbn: '9780593099322',
                coverUrl: 'https://covers.example/deluxe.jpg',
                coverWidth: 900,
                publisher: 'Penguin',
                pageCount: 688,
                source: 'Google Books',
              },
            ]
          : [],
      })),
    });
    const onSaved = vi.fn();
    renderWithApi(<BookEditor book={dune} onClose={() => {}} onSaved={onSaved} />, api);
    const user = userEvent.setup();

    const box = screen.getByLabelText('Not right? Search other editions');
    expect(box).toHaveValue('Dune Frank Herbert');
    await user.clear(box);
    await user.type(box, 'dune deluxe penguin{Enter}');
    // Enter searched instead of saving the form.
    expect(api.lookUpBook).toHaveBeenCalledWith(dune.isbn, 'dune deluxe penguin');
    expect(api.updateBook).not.toHaveBeenCalled();

    const results = await screen.findByRole('list', { name: 'Editions found' });
    expect(
      within(results).getByText(/Google Books · Penguin · 688 pages · ISBN 9780593099322 · cover 900px/),
    ).toBeInTheDocument();
    await user.click(within(results).getByRole('button', { name: 'Use cover' }));
    expect(within(results).getByRole('button', { name: 'Cover chosen' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(results).getByRole('button', { name: 'Use details' }));
    expect(screen.getByLabelText('Title')).toHaveValue('Dune (Deluxe Edition)');

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(api.updateBook).toHaveBeenCalledWith(dune.isbn, {
      title: 'Dune (Deluxe Edition)',
      publisher: 'Penguin',
      pageCount: 688,
      coverUrl: 'https://covers.example/deluxe.jpg',
      coverWidth: 900,
    });
  });
});

describe('nominating', () => {
  const editions = [
    {
      title: 'Dune',
      author: 'Frank Herbert',
      isbn: dune.isbn,
      coverUrl: 'https://covers.example/google.jpg',
      coverWidth: 800,
      publisher: 'Ace',
      pageCount: 412,
      source: 'Google Books',
    },
    {
      title: 'Dune: Deluxe Edition',
      author: 'Frank Herbert',
      isbn: '9780593099322',
      coverUrl: 'https://covers.example/ol.jpg',
      coverWidth: 1200,
      source: 'Open Library',
    },
  ];

  it('searches from the shelf, then chooses, checks and nominates on the nominate screen', async () => {
    const api = fakeApi({
      searchEditions: vi.fn().mockResolvedValue({ editions }),
      bookDetails: vi.fn().mockResolvedValue({
        book: { ...dune, coverUrl: 'https://covers.example/google.jpg', publisher: 'Ace', pageCount: 412 },
        canEdit: true,
        nomination: null,
        meetings: [],
        commentCount: 0,
      }),
    });
    const onChanged = vi.fn();
    renderWithApi(<LineupPanel lineup={lineupOf([])} onChanged={onChanged} />, api);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Search by title and/or author'), 'dune herbert');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    const dialog = await screen.findByRole('dialog', { name: 'Nominate a book' });
    expect(within(dialog).getByLabelText('Modify search')).toHaveValue('dune herbert');
    expect(api.searchEditions).toHaveBeenCalledWith('dune herbert');
    expect(api.searchBooks).not.toHaveBeenCalled();
    const results = await within(dialog).findByRole('list', { name: 'Search results' });
    expect(within(results).getAllByRole('listitem')[0]).toHaveTextContent('Google Books · Ace · 412 pages');
    // No ISBN controls on the way.
    expect(within(dialog).queryByText(/ISBN/)).not.toBeInTheDocument();

    await user.click(within(results).getByRole('button', { name: 'Choose: Dune (Google Books)' }));
    expect(within(dialog).getByLabelText('Title')).toHaveValue('Dune');
    // The deluxe edition's cover is offered too, as another cover of the same book.
    await user.click(within(dialog).getByRole('button', { name: 'Open Library cover, 1200px wide' }));
    await user.clear(within(dialog).getByLabelText('Publisher'));
    await user.type(within(dialog).getByLabelText('Publisher'), 'Ace Books');

    await user.click(within(dialog).getByRole('button', { name: 'Nominate' }));
    expect(api.nominate).toHaveBeenCalledWith(dune.isbn);
    await waitFor(() =>
      expect(api.updateBook).toHaveBeenCalledWith(dune.isbn, {
        publisher: 'Ace Books',
        coverUrl: 'https://covers.example/ol.jpg',
        coverWidth: 1200,
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onChanged).toHaveBeenCalled();
  });

  it('saves nothing extra when the details are kept as found', async () => {
    const api = fakeApi({
      searchEditions: vi.fn().mockResolvedValue({ editions }),
      bookDetails: vi.fn().mockResolvedValue({
        book: { ...dune, coverUrl: 'https://covers.example/google.jpg', publisher: 'Ace', pageCount: 412 },
        canEdit: true,
        nomination: null,
        meetings: [],
        commentCount: 0,
      }),
    });
    renderWithApi(<LineupPanel lineup={lineupOf([])} onChanged={() => {}} />, api);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Search by title and/or author'), 'dune{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Choose: Dune (Google Books)' }));
    await user.click(screen.getByRole('button', { name: 'Nominate' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.nominate).toHaveBeenCalledWith(dune.isbn);
    expect(api.updateBook).not.toHaveBeenCalled();
  });

  it("can't nominate a book already on the lineup", async () => {
    const api = fakeApi({ searchEditions: vi.fn().mockResolvedValue({ editions }) });
    renderWithApi(<LineupPanel lineup={lineupOf([dune])} onChanged={() => {}} />, api);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Search by title and/or author'), 'dune{Enter}');
    const results = await screen.findByRole('list', { name: 'Search results' });
    expect(within(results).getByRole('button', { name: /Dune \(Google Books\)/ })).toBeDisabled();
    expect(within(results).getByRole('button', { name: /Dune \(Google Books\)/ })).toHaveTextContent('On the lineup');
  });
});

describe('Modal', () => {
  it('pins the page while open so swipes scroll the popup, and restores it after', () => {
    const { rerender } = renderWithApi(
      <Modal open onClose={() => {}} title="Test">
        Hi
      </Modal>,
    );
    expect(document.body.style.position).toBe('fixed');
    rerender(
      <Modal open={false} onClose={() => {}} title="Test">
        Hi
      </Modal>,
    );
    expect(document.body.style.position).toBe('');
  });
});
