## @tegami/hex@0.2.0

### Migrate to the Tegami publish task system

The plugin now publishes through Tegami's task graph instead of the deprecated `publish` / `resolvePlanStatus` hooks. Requires `tegami@^1.3.0`.

Git-tag publishers (Composer, Swift, Zig's `git-tag` strategy) now wait for the git plugin's actual tag work: a package reports `published` when this run created its tag, `skipped` when the tag already existed, and fails when tag creation failed.

## @tegami/hex@0.1.0

### Add Elixir Mix support

Tegami now includes an opt-in `@tegami/hex` plugin that discovers Mix projects and umbrella apps, rewrites Elixir version requirements, and publishes with `mix hex.publish`.
