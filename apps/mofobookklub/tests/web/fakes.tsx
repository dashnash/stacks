import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import type { Api } from '../../web/src/lib/api';
import { ApiContext } from '../../web/src/lib/auth';
import type { Book, Lineup, MeetingView, User } from '../../web/src/lib/types';

export const books: Book[] = [
  { isbn: '9780593135204', title: 'Project Hail Mary', author: 'Andy Weir' },
  { isbn: '9780441172719', title: 'Dune', author: 'Frank Herbert' },
  { isbn: '9780547928227', title: 'The Hobbit', author: 'J.R.R. Tolkien' },
];

export const member: User = {
  id: 'u_alice',
  role: 'MEMBER',
  name: 'Alice',
};
export const admin: User = { ...member, id: 'u_admin', name: 'Admin', role: 'ADMIN' };

export function meeting(overrides: Partial<MeetingView> = {}): MeetingView {
  return {
    id: 'm1',
    title: 'October',
    dateTime: '2026-10-24T02:00:00.000Z',
    videoUrl: 'https://meet.google.com/abc',
    leaderId: 'jane@club.test',
    leader: { id: 'jane@club.test', name: 'Jane Doe' },
    status: 'UPCOMING',
    phase: 'PLANNING',
    createdAt: '2026-01-01T00:00:00Z',
    canManage: false,
    commentCount: 0,
    bookCommentCount: 0,
    ...overrides,
  };
}

/** A Lineup holding the given books, nominated by Marcus. */
export function lineupOf(list: Book[], overrides: Partial<Lineup> & { canWithdraw?: boolean } = {}): Lineup {
  const { canWithdraw = false, ...rest } = overrides;
  return {
    nominations: list.map((book, i) => ({
      id: `n${i}`,
      createdAt: '2026-01-01T00:00:00Z',
      book,
      nominatedBy: { id: 'marcus@club.test', name: 'Marcus Bell' },
      canWithdraw,
      votes: 0,
      myVote: false,
      commentCount: 0,
    })),
    canPick: false,
    meetingId: null,
    ...rest,
  };
}

/** A fake API where every method is a vi.fn() that resolves to something sensible. */
export function fakeApi(overrides: Partial<Record<keyof Api, unknown>> = {}): Api {
  const api = {
    publicShelf: vi.fn().mockResolvedValue({ current: null, books: [] }),
    publicBook: vi.fn(),
    nextMeeting: vi.fn().mockResolvedValue({ meeting: null, nextLeader: null, canCreateNext: false }),
    history: vi.fn().mockResolvedValue({ meetings: [] }),
    createMeeting: vi.fn().mockResolvedValue({}),
    updateMeeting: vi.fn().mockResolvedValue({}),
    chooseBook: vi.fn().mockResolvedValue({}),
    clearBook: vi.fn().mockResolvedValue({}),
    completeMeeting: vi.fn().mockResolvedValue({}),
    searchBooks: vi.fn().mockResolvedValue({ results: [] }),
    searchEditions: vi.fn().mockResolvedValue({ editions: [] }),
    lineup: vi.fn().mockResolvedValue({ nominations: [], canPick: false, meetingId: null }),
    bookDetails: vi.fn(),
    updateBook: vi.fn().mockResolvedValue({}),
    lookUpBook: vi.fn().mockResolvedValue({ found: null, covers: [] }),
    nominate: vi.fn(async (isbn: string) => ({
      nomination: { id: 'new', book: { isbn, title: 'Nominated', author: 'Someone' } },
    })),
    withdrawNomination: vi.fn().mockResolvedValue({}),
    vote: vi.fn().mockResolvedValue({}),
    unvote: vi.fn().mockResolvedValue({}),
    thread: vi.fn().mockResolvedValue({ comments: [] }),
    postComment: vi.fn().mockResolvedValue({}),
    editComment: vi.fn().mockResolvedValue({}),
    deleteComment: vi.fn().mockResolvedValue({}),
    randomEasterEgg: vi.fn(),
    faces: vi.fn().mockResolvedValue({ faces: [] }),
    uploadFaces: vi.fn().mockResolvedValue({ faces: [] }),
    deleteFace: vi.fn().mockResolvedValue({}),
    members: vi.fn().mockResolvedValue({ users: [] }),
    access: vi.fn().mockResolvedValue({ members: [], pending: [] }),
    setAccess: vi.fn().mockResolvedValue({}),
    portal: vi.fn().mockResolvedValue({ portalUrl: 'https://auth.club.test/#/' }),
    auditLog: vi.fn().mockResolvedValue({ events: [], nextBefore: null }),
    ...overrides,
  };
  return api as unknown as Api;
}

export function renderWithApi(ui: ReactElement, api: Api = fakeApi()) {
  return { api, ...render(<ApiContext.Provider value={api}>{ui}</ApiContext.Provider>) };
}
