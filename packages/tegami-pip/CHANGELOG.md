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
