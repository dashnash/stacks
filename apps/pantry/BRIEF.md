# Pantry

<!-- Written from issue #43, which stands in for the /new-app interview. -->

## What it is for

The household grocery list. Every member of the household sees every list; anyone can add, edit,
check off and remove items, with quick swipe gestures, per-list autocomplete from what the list has
had before, live updates between phones, and gentle (throttled) notifications.

## Who uses it

A household (two people to start). Private: people ask for access and the Owner approves them.

Roles (from app.manifest.json) and what each can do:

- **Owner**: everything a Member can, plus letting people in (`/stacks/access`) and choosing approvers.
- **Member**: create, rename and delete any list; add, edit, check off and remove any item; mute or
  unmute notifications for a list.

There is no per-list sharing: letting someone into the app shares every list with them.

## What it tracks

- **List**: `id` (UUID), `name`, `version` (bumped by every write), open/done counts, `createdBy`, timestamps.
- **Item**: `id`, `name` (1-80 chars, trimmed), `quantity` (optional, ≤20 chars free text), `done`,
  `doneAt`, `createdBy`, `updatedBy`, timestamps.
- **History entry** (per list, one per lower-cased name): display name, use count, last quantity,
  last-used time. Survives the item being removed or cleared.
- **Mute** (per user per list): everyone is subscribed to every list unless they mute it.
- **Last notified** (per list per subscriber): for the 10-minute throttle.

## What signed-out visitors see

A short landing page: what Pantry is, a "Sign in with Google" button and the SDK's request-access
notice. No list data.

## Look and feel

Calm, roomy, thumb-first. Big rows and tap targets (≥48 px), soft greens on off-white, full dark
mode, an add bar pinned to the bottom (name + quantity + Add). A small connection dot (live /
connecting / offline) in the list header.

## User stories

- As a member, I want to add "Milk, 2" to the weekly shop so that whoever goes shopping buys it.
- As a member, I want to swipe an item right to check it off, and Undo if I slipped.
- As a member, I want to long-swipe left to remove an item, and Undo it.
- As a member, I want "Clear complete" to tidy the list in one tap, with Undo.
- As a member, I want the add field to suggest names (and their last quantity) the list has had before.
- As a member, I want to see my partner's changes appear on my phone within a second.
- As a member, I want one notification when my partner adds things, not one per item, and to mute a list.
- As the Owner, I want to approve my partner's access request.
