# Critics' content

- `quotes.json` (in git): the parody critic quotes. A quote's `image` is a file name in this folder.
- `eggs/faces/` (**not in git**): the shared face photos shown for quotes without their own image.
  They live only in the app's private content bucket. The Book Club migration copies them from the
  old site; add more with `aws s3 cp <file> s3://<ContentBucketName>/eggs/faces/` (the stack prints
  the bucket name), or the uploads module once it exists.

Everything in this folder except `*.md` is uploaded to the content bucket on deploy, and deploys
never delete anything there.
