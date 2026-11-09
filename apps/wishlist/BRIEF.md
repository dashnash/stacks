# Wishlist

## What it is for

A family keeps gift wishlists in one place. Each person lists what they'd like; everyone else can
quietly claim an item so nobody buys the same thing twice. The surprise is sacred: you never see
whether, or by whom, anything on your own list was claimed.

## Who uses it

About 15 family members. Private: people ask to join and an organizer lets them in.

## Roles

- **Organizer**: lets people in; can tidy up (remove any item, e.g. a duplicate or something silly).
  Organizers keep their own list too, and the surprise rule applies to them as well.
- **Family member**: keeps their own list; browses everyone else's; claims, un-claims and marks
  items bought.

## What it tracks

- **List**: one per person, created when they add their first item or a note. Fields: owner, a short
  note (sizes, favorite colors, "no more mugs"; ≤300 chars), updated time.
- **Item**: on someone's list. Title (≤80), link (optional https URL), price (optional, whole
  dollars), priority (love it / like it / just an idea), notes (≤300), added time.
- **Claim**: one per item at most. Who claimed it, when, and whether they've bought it. **Never shown
  to the list's owner, in any form**: the owner's view doesn't say whether an item is claimed.

## What signed-out visitors see

What the app is, nothing else: no names, no lists.

## Look and feel

Cozy and clean, gently festive without being Christmas-only: soft green and cranberry on warm
white, a little ribbon accent on cards. Phone first.

## User stories

- As a family member, I add items to my list with a link, price, priority and notes, and edit or
  remove them.
- As a family member, I write a short note on my list (sizes, colors, things I don't want).
- As a family member, I see everyone's lists, and on someone else's list I see which items are
  still available, which I claimed, and which someone else claimed (but not who).
- As a family member, I claim an item, un-claim it, and mark it bought; "My claims" shows
  everything I've promised, grouped by person, so I can shop.
- As a list owner, I never learn whether my items were claimed (no counts, no hints), even when I
  edit or delete an item someone claimed.
- As an organizer, I can remove an inappropriate item from anyone's list.
