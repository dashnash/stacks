#!/usr/bin/env node
/**
 * Reads and updates a GitHub Projects (v2) board for the refine-backlog skill, through
 * `gh api graphql` (needs a token with the `project` scope: `gh auth refresh -s project`).
 *
 *   node board.mjs list <project-url> [--status Backlog] [--iteration current|any|<title>]
 *     Prints JSON: { project, statusField, items: [{ itemId, type, number, repo, title, url,
 *     status, iteration }] } for items in that status (default Backlog) and iteration (default
 *     current; "any" = no filter), in board order. Draft issues are listed with type "draft".
 *   node board.mjs move <project-url> <item-id> [--status Ready]
 *     Sets the item's Status (default Ready). Prints { itemId, status }.
 *
 * Project URLs look like https://github.com/users/<login>/projects/<n>[/views/..] or
 * https://github.com/orgs/<login>/projects/<n>.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function parseProjectUrl(url) {
  const m = /github\.com\/(users|orgs)\/([^/]+)\/projects\/(\d+)/.exec(url ?? '');
  if (!m) throw new Error(`Not a GitHub project URL: ${url}`);
  return { ownerType: m[1] === 'orgs' ? 'organization' : 'user', login: m[2], number: Number(m[3]) };
}

/** The iteration running on `today` (YYYY-MM-DD), from an iteration field's configuration. */
export function currentIteration(field, today) {
  const t = Date.parse(today);
  return (field?.configuration?.iterations ?? []).find((it) => {
    const start = Date.parse(it.startDate);
    return start <= t && t < start + it.duration * 86_400_000;
  });
}

/** Flattens raw project items and keeps those matching status and iteration. */
export function filterItems(project, { status = 'Backlog', iteration = 'current', today } = {}) {
  const fields = project.fields.nodes.filter(Boolean);
  const iterField = fields.find((f) => f.configuration);
  let iterTitle = null;
  if (iteration !== 'any' && iterField) {
    iterTitle = iteration === 'current' ? currentIteration(iterField, today)?.title : iteration;
    if (!iterTitle) throw new Error(`No ${iteration === 'current' ? 'current iteration' : `iteration "${iteration}"`} on this board`);
  }
  return project.items.map((node) => {
    const values = node.fieldValues.nodes.filter((v) => v?.field);
    const c = node.content ?? {};
    return {
      itemId: node.id,
      type: c.number ? 'issue' : 'draft',
      number: c.number ?? null,
      repo: c.repository?.nameWithOwner ?? null,
      title: c.title ?? '',
      url: c.url ?? null,
      status: values.find((v) => v.field.name === 'Status')?.name ?? null,
      iteration: iterField ? values.find((v) => v.field.name === iterField.name)?.title ?? null : null,
    };
  }).filter((i) => i.status === status && (iterTitle === null || i.iteration === iterTitle));
}

const FIELDS = `fields(first: 50) { nodes {
  ... on ProjectV2SingleSelectField { id name options { id name } }
  ... on ProjectV2IterationField { id name configuration { iterations { id title startDate duration } } } } }`;

const ITEMS = `items(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id
  content { ... on Issue { number title url repository { nameWithOwner } } ... on DraftIssue { title } }
  fieldValues(first: 30) { nodes {
    ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } }
    ... on ProjectV2ItemFieldIterationValue { title field { ... on ProjectV2IterationField { name } } } } } } }`;

function gh(query, vars) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(vars)) {
    if (v === null || v === undefined) continue;
    args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`);
  }
  const out = JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 << 20 }));
  if (out.errors?.length) throw new Error(out.errors.map((e) => e.message).join('; '));
  return out.data;
}

export function fetchProject(url, run = gh) {
  const { ownerType, login, number } = parseProjectUrl(url);
  const q = `query($login: String!, $number: Int!, $after: String) { ${ownerType}(login: $login) {
    projectV2(number: $number) { id title ${FIELDS} ${ITEMS} } } }`;
  let after = null;
  let project;
  const items = [];
  do {
    const p = run(q, { login, number, after })[ownerType]?.projectV2;
    if (!p) throw new Error(`Project not found or not readable: ${url}`);
    project ??= p;
    items.push(...p.items.nodes);
    after = p.items.pageInfo.hasNextPage ? p.items.pageInfo.endCursor : null;
  } while (after);
  return { ...project, items };
}

export function statusOption(project, name) {
  const field = project.fields.nodes.find((f) => f?.name === 'Status' && f.options);
  if (!field) throw new Error('This board has no Status field');
  const option = field.options.find((o) => o.name.toLowerCase() === name.toLowerCase());
  if (!option) throw new Error(`No Status "${name}"; options: ${field.options.map((o) => o.name).join(', ')}`);
  return { field, option };
}

function flag(args, name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}

function main(argv) {
  const [cmd, url, ...rest] = argv;
  if (cmd === 'list') {
    const project = fetchProject(url);
    const items = filterItems(project, {
      status: flag(rest, 'status', 'Backlog'),
      iteration: flag(rest, 'iteration', 'current'),
      today: new Date().toISOString().slice(0, 10),
    });
    const { field } = statusOption(project, flag(rest, 'status', 'Backlog'));
    return { project: { id: project.id, title: project.title }, statusField: { id: field.id, options: field.options.map((o) => o.name) }, items };
  }
  if (cmd === 'move') {
    const itemId = rest[0];
    if (!itemId) throw new Error('usage: move <project-url> <item-id> [--status Ready]');
    const project = fetchProject(url);
    const { field, option } = statusOption(project, flag(rest, 'status', 'Ready'));
    gh(`mutation($p: ID!, $i: ID!, $f: ID!, $o: String!) { updateProjectV2ItemFieldValue(input: {
      projectId: $p, itemId: $i, fieldId: $f, value: { singleSelectOptionId: $o } }) { projectV2Item { id } } }`,
      { p: project.id, i: itemId, f: field.id, o: option.id });
    return { itemId, status: option.name };
  }
  throw new Error('usage: board.mjs list|move <project-url> ...');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    console.log(JSON.stringify(main(process.argv.slice(2)), null, 2));
  } catch (e) {
    console.error(`board.mjs: ${e.message}`);
    process.exit(1);
  }
}
