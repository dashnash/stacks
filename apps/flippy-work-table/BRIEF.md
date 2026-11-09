# Flippy Work Table

## What it is for
A table-flipping toy. You pull up on a work table covered in office stuff; it flips, everything flies,
and you score points for what breaks plus how long things stay in the air. The joke: the site looks
like a cheap knockoff thrown together as fast as possible, with broken English, stray Cyrillic
letters and small harmless glitches. It is an original game in the table-flip genre, not a copy of
any existing site's code, art or look.

## Who uses it
Anyone who wants to flip a table for thirty seconds. Friends of the owner, sent a link.

## Roles
- **Owner** (`OWNER`): everything a Flipper can do, plus removing leaderboard entries. Manages access.
- **Flipper** (`FLIPPER`, default): anyone who signs in with Google.

## What it tracks
- **Flip**: one finished flip by a signed-in player: score, damage, hang time (ms), tool used, when.
- **Player stats**: per player: display name, best score, total points ("Flippy Coinz"), flip count.
- **Leaderboard**: best score per player (top 20), shown with first names only.
- **Tools** (fixed list in code): hand (free), boot, crowbar, "big hammer", "rocket", each unlocked
  at a total-points threshold. Tools change flip strength.

## What signed-out visitors see
The whole game, playable. Scores aren't saved; a banner says "Sign in for save you score!!".
The leaderboard is visible (first names only).

## Look and feel
Cheap, scraped, knockoff. Mismatched fonts (Comic-ish, Times, Impact), a marquee, clashing yellow
and blue, a fake "visitor counter", a "SALE ENDS IN" countdown that resets, a cookie banner that
comes back once after you close it, wrong currency symbols (₽$), Cyrillic letters swapped into
English words (Flippy Wоrk Tаblе), an unused "Download FULL VERSION.exe" button that only shows a
silly error. Nothing actually breaks; everything still works on phone and desktop.

## User stories
- As a visitor, I pull up (or press the big button) and the table flips and things fly.
- As a visitor, I see my score: damage + hang time.
- As a Flipper, my flip is saved; I see my best, my total coinz and my place on the leaderboard.
- As a Flipper, I unlock and pick a stronger tool once I have enough coinz.
- As the Owner, I remove a cheating entry from the leaderboard.
