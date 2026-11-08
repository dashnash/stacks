# Potluck

## What it is for

Planning potlucks for a group of friends and neighbors. A host posts an event and what it needs;
guests RSVP and sign up for a dish, so the food is balanced (no five desserts) and people with
dietary needs can see what they can eat.

## Who uses it

About 30 friends and neighbors. Private: people ask to join and a host lets them in.

## Roles

- **Host**: creates, edits and cancels potlucks; sets how many of each course are needed; lets people
  in (approves requests); can remove any dish sign-up.
- **Guest**: sees upcoming potlucks, RSVPs, signs up for (and changes or drops) their own dishes.

## What it tracks

- **Potluck (event)**: title, date and start time, place (address, members only), notes, host,
  cancelled flag.
- **Needs**: per event, how many dishes of each course: mains, sides, desserts, drinks (0-20 each).
- **Dish sign-up**: event, course, dish name (≤60 chars), serves (number, optional), dietary tags
  (vegetarian, vegan, gluten-free, dairy-free, nut-free), who brings it.
- **RSVP**: event, person, going / maybe / not going, extra guests (0-5).

## What signed-out visitors see

The app's name and tagline, and how many potlucks are coming up. No titles, places or names.

## Look and feel

Warm, cheerful, homemade: cream paper background, tomato red and mustard accents, rounded cards,
course "chips" with emoji (🍲 mains, 🥗 sides, 🍰 desserts, 🥤 drinks). Phone first.

## User stories

- As a host, I post a potluck with a date, place and what it needs, and everyone gets a notification.
- As a guest, I see upcoming potlucks, soonest first, with how full each course is.
- As a guest, I RSVP (going / maybe / not going, plus guests) and see the headcount.
- As a guest, I sign up to bring a dish for a course that still has room, with dietary tags; I can
  change or drop my own dish.
- As a guest with dietary needs, I see the tags on every dish.
- As a host, I edit or cancel a potluck, and remove a sign-up if needed.
- Past potlucks drop off the main list.
