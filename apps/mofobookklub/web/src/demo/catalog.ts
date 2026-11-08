import type { Book } from '../lib/types';

/**
 * The demo's stand-in for Open Library / Google Books: a fixed shelf of real
 * books (real ISBN-13s) so search and nomination work without network access.
 * Covers are original mock designs (frontend/demo-covers, made by
 * scripts/make-demo-covers.mjs), published beside the demo page as covers/<isbn>.jpg.
 */
const BOOKS: Book[] = [
  {
    isbn: '9780593135204',
    title: 'Project Hail Mary',
    author: 'Andy Weir',
    description: 'A lone astronaut wakes up with no memory and one job: save the Earth.',
  },
  {
    isbn: '9780441172719',
    title: 'Dune',
    author: 'Frank Herbert',
    description: 'Politics, prophecy and spice on the desert planet Arrakis.',
  },
  {
    isbn: '9780547928227',
    title: 'The Hobbit',
    author: 'J.R.R. Tolkien',
    description: 'Bilbo Baggins is hired, against his better judgment, as a burglar.',
  },
  {
    isbn: '9781635575637',
    title: 'Piranesi',
    author: 'Susanna Clarke',
    description: 'A man lives alone in an infinite house of statues and tides.',
  },
  {
    isbn: '9780679731726',
    title: 'The Remains of the Day',
    author: 'Kazuo Ishiguro',
    description: 'An English butler takes a road trip and reckons with a life of service.',
  },
  {
    isbn: '9780316556347',
    title: 'Circe',
    author: 'Madeline Miller',
    description: 'The witch of Aiaia tells her own story.',
  },
  {
    isbn: '9780593318171',
    title: 'Klara and the Sun',
    author: 'Kazuo Ishiguro',
    description: 'An Artificial Friend watches the family she was bought to serve.',
  },
  {
    isbn: '9780593321201',
    title: 'Tomorrow, and Tomorrow, and Tomorrow',
    author: 'Gabrielle Zevin',
    description: 'Two friends make video games together for thirty years.',
  },
  {
    isbn: '9780385547345',
    title: 'Lessons in Chemistry',
    author: 'Bonnie Garmus',
    description: 'A chemist in the 1960s ends up hosting a TV cooking show.',
  },
  {
    isbn: '9780525559474',
    title: 'The Midnight Library',
    author: 'Matt Haig',
    description: 'Between life and death is a library of the lives you could have lived.',
  },
  {
    isbn: '9780063251922',
    title: 'Demon Copperhead',
    author: 'Barbara Kingsolver',
    description: 'David Copperfield, retold in Appalachia during the opioid crisis.',
  },
  {
    isbn: '9780804172448',
    title: 'Station Eleven',
    author: 'Emily St. John Mandel',
    description: 'A travelling theatre troupe performs Shakespeare after the collapse.',
  },
  {
    isbn: '9780307744432',
    title: 'The Night Circus',
    author: 'Erin Morgenstern',
    description: 'A circus that only opens at night hosts a duel between two magicians.',
  },
  {
    isbn: '9780143110439',
    title: 'A Gentleman in Moscow',
    author: 'Amor Towles',
    description: 'A count is sentenced to house arrest in a grand hotel for decades.',
  },
  {
    isbn: '9781400078776',
    title: 'Never Let Me Go',
    author: 'Kazuo Ishiguro',
    description: 'Three friends grow up at an English boarding school with a secret.',
  },
  {
    isbn: '9780553418026',
    title: 'The Martian',
    author: 'Andy Weir',
    description: 'An astronaut stranded on Mars has to science his way home.',
  },
  {
    isbn: '9780399590504',
    title: 'Educated',
    author: 'Tara Westover',
    description: 'A memoir of growing up off the grid and getting to Cambridge.',
  },
  {
    isbn: '9780393356687',
    title: 'The Overstory',
    author: 'Richard Powers',
    description: 'Nine people whose lives are changed by trees.',
  },
  {
    isbn: '9781501160837',
    title: 'Anxious People',
    author: 'Fredrik Backman',
    description: 'A failed bank robber takes an apartment viewing hostage.',
  },
  {
    isbn: '9780316300131',
    title: 'The Ministry for the Future',
    author: 'Kim Stanley Robinson',
    description: 'A near-future agency fights climate change by any means.',
  },
  {
    isbn: '9780735219106',
    title: 'Where the Crawdads Sing',
    author: 'Delia Owens',
    description: 'A girl raised alone in the North Carolina marshes is accused of murder.',
  },
  {
    isbn: '9780062316097',
    title: 'Sapiens',
    author: 'Yuval Noah Harari',
    description: 'A brief history of humankind.',
  },
];

/** Publication details for some of the books, so their pages have something to show. */
const DETAILS: Record<string, Partial<Book>> = {
  '9780593135204': {
    publisher: 'Ballantine Books',
    publishedDate: '2021-05-04',
    pageCount: 496,
    subjects: ['Science fiction', 'Space', 'First contact'],
  },
  '9780593318171': {
    publisher: 'Knopf',
    publishedDate: '2021-03-02',
    pageCount: 303,
    subjects: ['Literary fiction', 'Artificial intelligence'],
  },
  '9780593321201': {
    publisher: 'Knopf',
    publishedDate: '2022-07-05',
    pageCount: 416,
    subjects: ['Literary fiction', 'Video games', 'Friendship'],
  },
  '9780063251922': {
    publisher: 'Harper',
    publishedDate: '2022-10-18',
    pageCount: 560,
    subjects: ['Literary fiction', 'Appalachia'],
  },
  '9780385547345': {
    publisher: 'Doubleday',
    publishedDate: '2022-04-05',
    pageCount: 400,
    subjects: ['Historical fiction', 'Science', 'Humor'],
  },
  '9781635575637': {
    publisher: 'Bloomsbury',
    publishedDate: '2020-09-15',
    pageCount: 272,
    subjects: ['Fantasy', 'Mystery'],
  },
};

export const DEMO_CATALOG: Book[] = BOOKS.map((b) => ({
  ...b,
  ...DETAILS[b.isbn],
  coverUrl: `covers/${b.isbn}.jpg`,
  coverWidth: 600,
}));
