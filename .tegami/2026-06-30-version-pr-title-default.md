---
packages:
  tegami: minor
---

### Include the release version in the default Version Packages PR title

When every released package lands on the same version — a single-package repo, or a group with `syncBump`/`syncGitTag` — the Version Packages pull/merge request is now titled `Version Packages v<version>` instead of the bare `Version Packages`. Releases with independent per-package versions keep the bare title (there is no single version to show). Override it with `versionPr.create()` / `versionMr.create()` as before.
