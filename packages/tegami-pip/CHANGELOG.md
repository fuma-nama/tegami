## @tegami/pip@1.3.0

### Migrate to the Tegami publish task system

The plugin now publishes through Tegami's task graph instead of the deprecated `publish` / `resolvePlanStatus` hooks. Requires `tegami@^1.3.0`.

Git-tag publishers (Composer, Swift, Zig's `git-tag` strategy) now wait for the git plugin's actual tag work: a package reports `published` when this run created its tag, `skipped` when the tag already existed, and fails when tag creation failed.

## @tegami/pip@1.2.5

### No longer align with core versions

The package versions of plugins will no longer align with core `tegami` package.

## @tegami/pip@1.2.4

### No longer add `enforce`

Built-in plugins no longer add `enforce`, this ensures custom plugins always take priority in ordering.

## @tegami/pip@1.2.1

### Support custom commit messages

### Improve error messages for HTTP requests

## @tegami/pip@1.1.3

### Support Partial Publishing

Only publish a subset of bumped packages.

## @tegami/pip@1.1.1

### Experiment `typia` compile-time validation

Try to precompile schema using `typia`.

## @tegami/pip@1.0.2

### Align pip workspace handling with uv

Workspace roots are now graph members, root `tool.uv.sources` inherit to members, virtual roots and `exclude` globs are supported, and dependency source lookup uses PEP 503 name normalization.

## @tegami/pip@1.0.0

### Make Cargo plugin opt-in

The Cargo plugin is no longer enabled by default. Add `cargo()` from `tegami/plugins/cargo` to your `plugins` array for Rust workspace support.

### v1 stable

This marks all v1 APIs as stable.
