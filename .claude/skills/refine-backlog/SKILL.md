---
name: refine-backlog
description: Refine a GitHub project board's backlog - go through every Backlog item in an iteration one by one, research the codebase, grill the owner with multiple-choice questions, write an autonomous execution spec into the issue description, and move the item to Ready. Use when someone runs /refine-backlog, or asks to refine, groom or spec the backlog or a board/iteration. For a single issue, use it with that issue only.
---

# /refine-backlog

Turn each loose backlog item ("migrate to new domain", "add uploads") into a spec another agent can
carry out **without asking anything**, then mark it Ready. The owner's time is the scarce part:
research everything the code can answer, and ask only what it can't.

**Input:** a project URL (`https://github.com/users/<login>/projects/<n>`, view URLs are fine),
optionally `--iteration <title|current|any>` (default `current`) and `--status <name>` (default
`Backlog`). If there's no URL, ask for one. A link to one item (`…&issue=owner|repo|42`) means refine
just that issue, but still move it on its board.

## 1. Load the board

```bash
node .claude/skills/refine-backlog/board.mjs list "<project-url>" --iteration current
```

It prints the items (`itemId`, `number`, `repo`, `title`, `status`, `iteration`) in board order.
If `gh` fails with a scope or permission error, tell the owner to run `gh auth refresh -s project`
on a machine with `gh`. If you can't reach the board here (for example, in a cloud session `gh`
may not be allowed for anything but search), ask for the issue numbers. Then refine them anyway
and list the ones they need to move by hand at the end. Never ask for a token.

Show the list as a short numbered list, ask which to skip (if any), and say you'll take them in
order. **Draft items** (`type: "draft"`) have no issue to write into, so ask the owner to convert
them to issues, or skip them.

## 2. For each item, one at a time

### a. Read and research (no questions yet)

- Read the issue and its comments (GitHub MCP `issue_read` with `get` and `get_comments`). If the
  body already holds a spec in this skill's format, check what's missing and ask only about that.
- Read the repo's `CLAUDE.md` and whatever it says to read first (for Stacks:
  `docs/PLATFORM_SPEC.md`, the relevant `packages/*/README.md`, `docs/NATIVE_APP_SPEC.md` for iOS).
- Find **everything the change touches**: grep for the names, domains, IDs and strings the issue
  mentions; read the config, the infra, the tests that pin current behaviour, and the docs that
  describe it. Note the concrete files. This is what makes your questions sharp and your spec
  executable.
- Work out the task's class under the repo rules (Stacks: an *app task* edits only `apps/<slug>/`;
  anything in `packages/`, `platform/`, `infra/`, `.github/`, `native/`, `.claude/` is a *platform
  task* that needs `@dashnash` review). Also work out what an agent **can't** do in a session:
  AWS, App Store Connect, Google Cloud console, DNS registrars, real devices. Those become manual
  steps for the owner.
- Tell the owner in one line what the item touches before you ask anything.

### b. Grill

Use `AskUserQuestion`. Each round has up to 4 questions, each with 2–4 concrete options and
the recommended one first, marked "(Recommended)". The owner can always type "Other".

- **Ask only decisions that are the owner's**: scope, naming, look and feel, what happens to old
  things, rollout order, acceptable user impact, who provides assets, what a manual step needs.
  Don't ask what the code, the spec or a sensible default answers. Decide those and note them.
- **Lead with what blocks everything else** (a typo in the title, the exact target, does X already
  exist), then the shape of the change, then the edges (migration, old data, failure, rollout).
- **Make options real**: name the actual files, IDs and values you found ("`ninja.dashnash.stacks` →
  `ninja.dashnash.stacks`"), and put the trade-off in the description ("means new App Store records").
- If an answer opens a new decision, ask about it in the next round. Usually 2–3 rounds is enough.
  Stop when an agent could build it without asking anything. Don't pad.
- In the last round, include **"Spec this and mark Ready?"** with the options *Mark Ready*, *One
  more round* and *Save the spec, leave it in Backlog*.
- If the owner says something mid-item ("skip this one", "do X when done"), follow it and carry on.

### c. Write the spec into the issue description

Replace the body with `issue_write` (`update`). Keep the owner's original text: quote it as
`> Original: …` at the bottom if the spec doesn't already cover it word for word. Fix an obvious typo
in the title the owner confirmed. Use this layout. Leave out any section that would be empty:

```markdown
<One or two sentences: what changes and the outcome.>

## Decisions (settled, don't reopen)
| Topic | Decision |   ← every answer from the grilling, plus defaults you chose (mark them "default")

## Manual steps for <owner> (the agent can't do these)
Numbered, each with when it's needed ("before PR 1 deploys"). State that the agent must not block
on them: use placeholders and keep coding.

## PR 1: <name>   (one section per PR, if it's staged)
Grouped by area. Concrete files, config keys, values, behaviour, and the tests to add (cases
listed). Point out risks and say which way to handle them, or that the agent picks and writes it down.

## Merge plan   (only when there's more than one PR)
The order the PRs merge in, which wait for a green deploy (all, by default), and the owner steps
between them as their own lines. Sessions follow it with `.claude/skills/merge-train/SKILL.md`.

## Acceptance (agent-verifiable in a session)
Commands that must pass (for Stacks: `npm test`, `npm run typecheck`, `npm run lint`,
`npm run build`, `cdk synth` for both envs without credentials, a grep that must come back empty,
demo screenshots).

## Acceptance (<owner>, after deploy)
What they check by hand, with exact URLs or steps.

## Out of scope
```

Write it for an agent with **no access to this conversation**: no "as discussed", no option
labels. Spell out each decision. Keep it tight: tables and bullets, about one screen per PR.

### d. Move it to Ready

Only if the owner chose *Mark Ready*:

```bash
node .claude/skills/refine-backlog/board.mjs move "<project-url>" <itemId> --status Ready
```

If the board can't be reached, add the item to a "move by hand" list. Then say in one line what
you did (`#42 → Ready`, link) and go on to the next item.

## 3. Wrap up

Write a short table: item, what happened (Ready / spec saved, left in Backlog / skipped), and link.
Then list anything to move by hand, and any manual steps that block work starting.

## Don'ts

- Don't change code, branches or PRs. This skill only edits issue descriptions, titles and board
  status.
- Don't edit an item you weren't asked about, and don't move anything that isn't fully specced.
- Don't comment on issues (it notifies people). The description is the deliverable.
- Don't put secrets, keys or anyone's email address in a spec.

## Helper

`board.mjs` (`list` and `move`) wraps `gh api graphql` for Projects v2. Tests:
`node --test .claude/skills/refine-backlog/board.test.mjs`.
