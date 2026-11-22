import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createClient, StacksProvider } from '@stacks/web';
import { describe, expect, it, vi } from 'vitest';
import { ApiContext } from '../../web/src/lib/auth';
import { PublicHeadliner, PublicShelf } from '../../web/src/components/PublicShelf';
import { PublicBookView } from '../../web/src/views/PublicBookView';
import { fakeApi, renderWithApi } from './fakes';

describe('PublicShelf', () => {
  it('shows past books as hover cards that open their public pages', () => {
    renderWithApi(
      <PublicShelf
        books={[
          {
            readOn: '2026-03-01T12:00:00Z',
            book: {
              isbn: '9780593135204',
              title: 'Project Hail Mary',
              author: 'Andy Weir',
              publisher: 'Ballantine',
              publishedDate: '2021-05-04',
              pageCount: 496,
            },
          },
          { readOn: '2026-02-01T12:00:00Z', book: { isbn: '9780441172719', title: 'Dune', author: 'Frank Herbert' } },
        ]}
      />,
    );
    expect(screen.getByText('The shelf · 2 books read')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Project Hail Mary' })).toHaveAttribute('href', '#/book/9780593135204');
    const card = screen.getByRole('link', { name: 'Dune' }).closest('li')!;
    expect(card.querySelector('.reveal-panel')).toHaveTextContent(/FEB ’26|Feb ’26/i);
    expect(screen.getByText('Ballantine · May 4, 2021 · 496 pages')).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('shows nothing when no books have been read yet', () => {
    const { container } = renderWithApi(<PublicShelf books={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('PublicHeadliner', () => {
  it('shows the next meeting date and the book, and no host', () => {
    renderWithApi(
      <PublicHeadliner
        meetsOn="2026-11-20T03:15:00Z"
        book={{ isbn: '9780593135204', title: 'Project Hail Mary', author: 'Andy Weir' }}
      />,
    );
    expect(screen.getByText(/Now reading · next meeting/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/NOV|Nov/);
    expect(screen.getAllByRole('link', { name: 'Project Hail Mary' })[0]).toHaveAttribute(
      'href',
      '#/book/9780593135204',
    );
    expect(screen.queryByText(/host|leads/i)).not.toBeInTheDocument();
  });
});

describe('PublicBookView', () => {
  it('shows the book, its details and Buy on Amazon, with nothing about members', async () => {
    const api = fakeApi({
      publicBook: vi.fn().mockResolvedValue({
        book: {
          isbn: '9780593135204',
          title: 'Project Hail Mary',
          author: 'Andy Weir',
          description: 'A lone astronaut must save the earth.',
          publisher: 'Ballantine',
          amazonUrl: 'https://www.amazon.com/dp/0593135202',
        },
        readOn: ['2026-03-01T12:00:00Z'],
        meetsOn: null,
      }),
    });
    renderWithApi(<PublicBookView isbn="9780593135204" />, api);
    expect(await screen.findByRole('heading', { level: 1, name: 'Project Hail Mary' })).toBeInTheDocument();
    expect(screen.getByText(/Read in Mar ’26/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Buy Project Hail Mary on Amazon/ })).toHaveAttribute(
      'href',
      'https://www.amazon.com/dp/0593135202',
    );
    const page = screen.getByRole('article');
    expect(within(page).queryByRole('button')).not.toBeInTheDocument();
    expect(api.publicBook).toHaveBeenCalledWith('9780593135204');
  });

  it('asks someone who opened a shared comment to sign in, and comes back to the same link', async () => {
    const api = fakeApi({
      publicBook: vi.fn().mockResolvedValue({
        book: { isbn: '9780593135204', title: 'Project Hail Mary', author: 'Andy Weir', amazonUrl: 'https://www.amazon.com/dp/0593135202' },
        readOn: [],
        meetsOn: null,
      }),
    });
    const fetch = vi.fn(async () => new Response('{}', { status: 401 }));
    const nav = { visited: [] as string[], assign: (u: string) => void nav.visited.push(u), current: () => '/#/book/9780593135204/comment/c1' };
    render(
      <StacksProvider client={createClient({ fetch: fetch as unknown as typeof globalThis.fetch })} navigator={nav}>
        <ApiContext.Provider value={api}>
          <PublicBookView isbn="9780593135204" commentId="c1" />
        </ApiContext.Provider>
      </StacksProvider>,
    );
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Sign in to see the discussion' }));
    expect(nav.visited).toEqual([`/api/auth/login?return=${encodeURIComponent('/#/book/9780593135204/comment/c1')}`]);
  });
});
