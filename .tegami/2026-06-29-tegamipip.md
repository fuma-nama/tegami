---
packages:
  "npm:@tegami/pip": minor
  "npm:tegami": patch
---

### Extract pip plugin to `@tegami/pip`

The Python pip plugin now lives in `@tegami/pip` instead of `tegami/plugins/pip`. Dependency range checks use PEP 440 via `@renovatebot/pep440`, and PyPI name normalization follows PEP 503.

Tegami exports additional subpaths (`tegami/graph`, `tegami/context`, and others) for plugin packages.
