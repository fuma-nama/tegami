---
packages:
  npm:tegami: patch
---

### Harden publish task execution and tag retries

Publish task graphs now reject duplicate package publishers, reused task instances, invalid concurrency, and package tasks outside the selected release. The executor starts newly unblocked work immediately while respecting its concurrency limit, preserves required dependency edges consistently, and keeps legacy `afterPublishAll` hooks ordered.

Git tag retries now push tags left locally by a partial prior attempt, keep publish status pending until requested tags reach the remote, and only accept concurrent push conflicts when the remote tags point to the expected commits.
