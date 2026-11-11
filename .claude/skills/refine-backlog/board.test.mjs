// Run: node --test .claude/skills/refine-backlog/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { currentIteration, fetchProject, filterItems, parseProjectUrl, statusOption } from './board.mjs';

const iterField = {
  id: 'F_iter', name: 'Iteration',
  configuration: { iterations: [
    { id: 'i1', title: 'Iteration 1', startDate: '2026-11-02', duration: 14 },
    { id: 'i2', title: 'Iteration 2', startDate: '2026-11-16', duration: 14 },
  ] },
};
const statusField = { id: 'F_status', name: 'Status', options: [
  { id: 'o_b', name: 'Backlog' }, { id: 'o_r', name: 'Ready' }, { id: 'o_d', name: 'Done' },
] };
const item = (id, number, status, iteration) => ({
  id,
  content: number ? { number, title: `#${number}`, url: `u/${number}`, repository: { nameWithOwner: 'o/r' } } : { title: 'draft' },
  fieldValues: { nodes: [
    {},
    status && { name: status, field: { name: 'Status' } },
    iteration && { title: iteration, field: { name: 'Iteration' } },
  ].filter((v) => v !== null && v !== undefined) },
});
const project = {
  id: 'P', title: 'Board', fields: { nodes: [{}, statusField, iterField] },
  items: [
    item('a', 1, 'Backlog', 'Iteration 1'),
    item('b', 2, 'Ready', 'Iteration 1'),
    item('c', 3, 'Backlog', 'Iteration 2'),
    item('d', null, 'Backlog', 'Iteration 1'),
    item('e', 5, 'Backlog', null),
  ],
};

test('parses user and org project URLs, including view URLs', () => {
  assert.deepEqual(parseProjectUrl('https://github.com/users/dashnash/projects/2/views/1?pane=issue'),
    { ownerType: 'user', login: 'dashnash', number: 2 });
  assert.deepEqual(parseProjectUrl('https://github.com/orgs/acme/projects/7'),
    { ownerType: 'organization', login: 'acme', number: 7 });
  assert.throws(() => parseProjectUrl('https://github.com/dashnash/stacks/issues/42'));
});

test('finds the iteration running today', () => {
  assert.equal(currentIteration(iterField, '2026-11-11').title, 'Iteration 1');
  assert.equal(currentIteration(iterField, '2026-11-16').title, 'Iteration 2');
  assert.equal(currentIteration(iterField, '2027-01-01'), undefined);
});

test('filters Backlog items in the current iteration, drafts flagged', () => {
  const got = filterItems(project, { today: '2026-11-11' });
  assert.deepEqual(got.map((i) => [i.itemId, i.type]), [['a', 'issue'], ['d', 'draft']]);
  assert.equal(got[0].repo, 'o/r');
});

test('iteration by title, or any', () => {
  assert.deepEqual(filterItems(project, { iteration: 'Iteration 2' }).map((i) => i.itemId), ['c']);
  assert.deepEqual(filterItems(project, { iteration: 'any' }).map((i) => i.itemId), ['a', 'c', 'd', 'e']);
  assert.throws(() => filterItems(project, { today: '2027-01-01' }), /No current iteration/);
});

test('resolves Status options case-insensitively', () => {
  assert.equal(statusOption(project, 'ready').option.id, 'o_r');
  assert.throws(() => statusOption(project, 'Refined'), /options: Backlog, Ready, Done/);
});

test('pages through items', () => {
  const pages = [
    { hasNextPage: true, endCursor: 'c1', nodes: [project.items[0]] },
    { hasNextPage: false, endCursor: null, nodes: [project.items[1]] },
  ];
  const seen = [];
  const run = (_q, vars) => {
    seen.push(vars.after);
    const page = pages.shift();
    return { user: { projectV2: { ...project, items: { pageInfo: page, nodes: page.nodes } } } };
  };
  const p = fetchProject('https://github.com/users/x/projects/1', run);
  assert.deepEqual(p.items.map((i) => i.id), ['a', 'b']);
  assert.deepEqual(seen, [null, 'c1']);
});
