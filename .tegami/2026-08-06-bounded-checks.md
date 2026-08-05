---
packages:
  npm:tegami: patch
---

### Bound the checks & releases a plan runs at once

Release creation, the release checks behind a plan's status, and the npm registry lookups of `npm pretrust` now run at most `unstable_maxChunk` (5 by default) at a time, instead of firing one request per package or git tag at once. Release checks also stop as soon as one is missing.

### Skip version request updates that change nothing

The version pull/merge request is now only updated when its title or body actually changed, removing one write request per run.
