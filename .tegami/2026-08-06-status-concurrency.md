---
packages:
  npm:tegami: patch
---

### Limit concurrent status checks

Publish plan status checks now respect `unstable_maxChunk` like publish tasks do, instead of checking every task at once. Remaining checks are skipped as soon as a task reports `pending`.
