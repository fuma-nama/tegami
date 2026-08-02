## @tegami/zig@1.3.0

### Migrate to the Tegami publish task system

The plugin now publishes through Tegami's task graph instead of the deprecated `publish` / `resolvePlanStatus` hooks. Requires `tegami@^1.3.0`.

Git-tag publishers (Composer, Swift, Zig's `git-tag` strategy) now wait for the git plugin's actual tag work: a package reports `published` when this run created its tag, `skipped` when the tag already existed, and fails when tag creation failed.

## @tegami/zig@1.2.5

### No longer align with core versions

The package versions of plugins will no longer align with core `tegami` package.

### Add Zig package support

Tegami now includes an opt-in `@tegami/zig` plugin that discovers `build.zig.zon` packages, follows local `.path` dependencies, bumps dependent packages, and preserves manifest comments while updating package versions.
