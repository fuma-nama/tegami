---
packages:
  npm:tegami: patch
---

### Evaluate dependency policies against final bumps

Dependency policies (e.g. npm peer range checks) now run after the direct bumps of every changeset settled, instead of reacting to each changeset with intermediate versions. Previously, a patch changeset processed before a minor one could break a peer range that the final version satisfies, escalating dependents to an unwanted major bump.
