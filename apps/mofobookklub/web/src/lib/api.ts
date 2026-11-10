import type { Client } from '@stacks/web';
import type {
  AuditEvent,
  Book,
  BookCandidate,
  BookDetails,
  BookPageBook,
  BookUpdate,
  CoverCandidate,
  Edition,
  BookChoice,
  CommentView,
  Lineup,
  ThreadKind,
  EasterEgg,
  FacePhotoView,
  MeetingInput,
  MeetingView,
  NextMeetingResponse,
  PastMeeting,
  PublicBookPage,
  PublicShelf,
  Person,
  Role,
} from './types';

export { ApiError } from '@stacks/web';

/** People with a role here and requests waiting (admins only), from the platform via /stacks/access. */
export interface AccessPerson {
  id: string;
  name: string;
  pictureUrl?: string;
  role: string;
  requestedAt?: string | null;
}

/** Book Club's API. Requests go through the Stacks client: same-origin cookie session + CSRF header. */
export function createApi(client: Client) {
  const request = <T,>(method: string, path: string, body?: unknown) => client.request<T>(method, path, body);

  const meetingAction = (id: string, action: string, body?: unknown) =>
    request<{ meeting: MeetingView }>('POST', `/meetings/${encodeURIComponent(id)}/${action}`, body ?? {});

  return {
    /** No sign-in needed. */
    publicShelf: () => request<PublicShelf>('GET', '/public/shelf'),
    /** No sign-in needed; only the current headliner and books the Klub has read. */
    publicBook: (isbn: string) => request<PublicBookPage>('GET', `/public/books/${encodeURIComponent(isbn)}`),

    nextMeeting: () => request<NextMeetingResponse>('GET', '/meetings/next'),
    history: () => request<{ meetings: PastMeeting[] }>('GET', '/meetings/history'),
    createMeeting: (input: MeetingInput) => request<{ meeting: MeetingView }>('POST', '/meetings', input),
    updateMeeting: (id: string, input: Partial<MeetingInput>) =>
      request<{ meeting: MeetingView }>('PATCH', `/meetings/${encodeURIComponent(id)}`, input),
    chooseBook: (id: string, choice: BookChoice) => meetingAction(id, 'book', choice),
    clearBook: (id: string) => request<{ meeting: MeetingView }>('DELETE', `/meetings/${encodeURIComponent(id)}/book`),
    completeMeeting: (id: string, nextLeaderId: string) => meetingAction(id, 'complete', { nextLeaderId }),

    searchBooks: (q: string) =>
      request<{ results: BookCandidate[] }>('GET', `/books/search?q=${encodeURIComponent(q)}`),
    /** Search for a book to nominate: editions with ISBNs and their details, Google Books first. */
    searchEditions: (q: string) =>
      request<{ editions: Edition[] }>('GET', `/books/editions?q=${encodeURIComponent(q)}`),
    bookDetails: (isbn: string) => request<BookDetails>('GET', `/books/${encodeURIComponent(isbn)}/details`),
    updateBook: (isbn: string, changes: BookUpdate) =>
      request<{ book: BookPageBook }>('PATCH', `/books/${encodeURIComponent(isbn)}`, changes),
    /** Look a book up again: by its ISBN, or with `q`, editions matching free-text search terms. */
    lookUpBook: (isbn: string, q?: string) =>
      request<{ found: Book | null; covers: CoverCandidate[]; editions: Edition[] }>(
        'GET',
        `/books/${encodeURIComponent(isbn)}/lookup${q ? `?q=${encodeURIComponent(q)}` : ''}`,
      ),
    lineup: () => request<Lineup>('GET', '/nominations'),
    nominate: (isbn: string) => request<{ nomination: { id: string; book: Book } }>('POST', '/nominations', { isbn }),
    withdrawNomination: (id: string) => request<unknown>('DELETE', `/nominations/${encodeURIComponent(id)}`),
    vote: (nominationId: string) => request<unknown>('POST', `/nominations/${encodeURIComponent(nominationId)}/vote`),
    unvote: (nominationId: string) =>
      request<unknown>('DELETE', `/nominations/${encodeURIComponent(nominationId)}/vote`),

    thread: (kind: ThreadKind, id: string) =>
      request<{ comments: CommentView[] }>('GET', `/threads/${kind}/${encodeURIComponent(id)}`),
    postComment: (kind: ThreadKind, id: string, body: string, parentId?: string) =>
      request<{ comment: CommentView }>('POST', `/threads/${kind}/${encodeURIComponent(id)}`, {
        body,
        ...(parentId ? { parentId } : {}),
      }),
    editComment: (kind: ThreadKind, id: string, commentId: string, body: string) =>
      request<{ comment: CommentView }>(
        'PATCH',
        `/threads/${kind}/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`,
        { body },
      ),
    deleteComment: (kind: ThreadKind, id: string, commentId: string) =>
      request<unknown>(
        'DELETE',
        `/threads/${kind}/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`,
      ),

    randomEasterEgg: (excludeId?: string) =>
      request<EasterEgg>('GET', `/easter-egg/random${excludeId ? `?exclude=${encodeURIComponent(excludeId)}` : ''}`),

    /** Admins: the shared face photos on the critics' quotes. */
    faces: () => request<{ faces: FacePhotoView[] }>('GET', '/admin/faces'),
    /** Admins: add face photos (`data` base64, within the API's per-request limits). */
    uploadFaces: (photos: { fileName: string; data: string }[]) =>
      request<{ faces: FacePhotoView[] }>('POST', '/admin/faces', { photos }),
    deleteFace: (name: string) => request<unknown>('DELETE', `/admin/faces/${encodeURIComponent(name)}`),

    members: () => request<{ users: (Person & { role: Role })[] }>('GET', '/users'),
    /** Admins: members and requests, from the platform. */
    access: () => request<{ members: AccessPerson[]; pending: AccessPerson[]; blocked?: AccessPerson[] }>('GET', '/stacks/access'),
    /** Admins: approve, change a role, remove (null) or block. The platform applies its rules (only owners make admins). */
    setAccess: (userId: string, role: Role | 'BLOCKED' | null) => request<unknown>('PUT', `/stacks/access/${encodeURIComponent(userId)}`, { role }),
    /** Links to the platform portal (profile, all apps). */
    portal: () => request<{ portalUrl: string }>('GET', '/stacks/bar'),
    /** The activity log, newest first. `action` may be a prefix such as "comment". */
    auditLog: (opts: { before?: string; actor?: string; action?: string; limit?: number } = {}) => {
      const query = new URLSearchParams(
        Object.entries(opts).flatMap(([k, v]) => (v === undefined || v === '' ? [] : [[k, String(v)]])),
      ).toString();
      return request<{ events: AuditEvent[]; nextBefore: string | null }>(
        'GET',
        `/admin/audit${query ? `?${query}` : ''}`,
      );
    },
  };
}

export type Api = ReturnType<typeof createApi>;
