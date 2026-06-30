---
packages:
  "tegami": patch
  "@tegami/pip": patch
---

### Harden publish reliability and tests

Git status failures now surface as errors, npm registry publish checks are cached within a run, publish lock consumption is explicit, generated changelog filenames are more collision-resistant, CRLF changelog rewrites preserve line endings, and the pip tests import source files instead of requiring a prior build.
