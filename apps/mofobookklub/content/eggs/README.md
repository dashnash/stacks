# Critics' content

- `quotes.json` (in git): the parody critic quotes. They are unsigned (no critic's name), so any
  face suits any quote. A quote's `image` is a file name in this folder.
- `eggs/faces/` (**not in git**): the shared face photos shown for quotes without their own image.
  They live only in the app's private content bucket. Admins manage them on the admin page
  (Critic photos: upload a .zip of photos, view, delete); the browser shrinks each to 640 px JPEG,
  which also drops camera and location metadata.

Everything in this folder except `*.md` is uploaded to the content bucket on deploy, and deploys
never delete anything there.
