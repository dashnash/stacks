# Stacks

A platform for quickly building a collection of small web apps on AWS that share:

- **one Google sign-in**, federated into every app on its own subdomain,
- **a catalog** where users browse and deep-link into apps,
- **a central access grid** (users × apps, role in each cell) for admins and app owners,
- **shared infrastructure and SDKs**, so a new app is bootstrapped by scripts and the `/new-app`
  Claude Code skill, with full freedom over its UX.

The MOFO Book Club Portal is the reference app and will be app #1.

Status: specification. See [docs/PLATFORM_SPEC.md](docs/PLATFORM_SPEC.md).
