## Tegami

WIP.

## Current Design

**Tegami** has two main phases: versioning and publishing.

### Versioning

`tegami().draft()` creates a draft plan intance, allowing consumers to modify the plan, and apply the plan to bump/overwrite package versions.
A publish plan will be stored in `.tegami/publish-plan.json` after applying.

Publish plan files do not store mutable status. This keeps CI publishing simple: a release job can publish from the committed plan without needing to write a follow-up commit that marks the plan complete or removes it.

### Publishing

During the publish phase, `tegami().publish()` reads the queued plans, checks the remote registry, skips versions that already exist, and publishes only missing versions. The publish phase does not update or remove the plan file.

Cleanup happens during the next versioning phase. Before writing a new plan, Tegami checks queued plans against the registry, removes already-published package entries, and drops plans that have no remaining unpublished packages.
