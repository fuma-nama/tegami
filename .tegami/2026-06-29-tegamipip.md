---
packages:
  "npm:@tegami/pip": minor
  "npm:tegami": patch
---

### Extract pip plugin to `@tegami/pip`

The Python pip plugin now lives in `@tegami/pip` instead of `tegami/plugins/pip`. Dependency range checks use PEP 440 via `@renovatebot/pep440`, and PyPI name normalization follows PEP 503.

Tegami exports the plugin hooks and graph types needed by `@tegami/pip` from the root `tegami` entry.
