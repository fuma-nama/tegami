---
packages:
  npm:tegami: patch
---

### Fix publish task system regressions

Dry runs no longer create GitHub/GitLab releases: release tasks now honor `dryRun`, matching the git tag task and the documented `PublishOptions.dryRun` contract.

`afterPublish` hooks run again for failed publishes, restoring the documented lifecycle contract, and they can observe the outcome through the package's `publishResult` during the hook.

Publish status checks no longer risk crashing on an unhandled rejection when a synchronously pending task (e.g. a waiting publish group) resolves the status before async task checks settle.

The `tegami publish` CLI reports every failed publish task with its error message and a proper exit code, instead of printing only the aggregate count.
