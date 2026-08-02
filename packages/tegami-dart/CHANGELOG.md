## @tegami/dart@1.3.0

### Migrate to the Tegami publish task system

The plugin now publishes through Tegami's task graph instead of the deprecated `publish` / `resolvePlanStatus` hooks. Requires `tegami@^1.3.0`.

Git-tag publishers (Composer, Swift, Zig's `git-tag` strategy) now wait for the git plugin's actual tag work: a package reports `published` when this run created its tag, `skipped` when the tag already existed, and fails when tag creation failed.

## @tegami/dart@1.2.5

### No longer align with core versions

The package versions of plugins will no longer align with core `tegami` package.

## @tegami/dart@1.2.4

### No longer add `enforce`

Built-in plugins no longer add `enforce`, this ensures custom plugins always take priority in ordering.

## @tegami/dart@1.2.1

### Support custom commit messages

### Improve error messages for HTTP requests

## @tegami/dart@1.1.1

### Replace `js-yaml` with `yaml`

`yaml` supports preserving formatting while editing properties, this is useful for updating package manifest files.

### Experiment `typia` compile-time validation

Try to precompile schema using `typia`.

## @tegami/dart@1.1.0

### Add Dart pub plugin

Tegami now includes an opt-in Dart plugin at `@tegami/dart` for official pub workspaces. It discovers packages from `pubspec.yaml`, bumps workspace dependency ranges, runs `dart pub get` after versioning, and publishes with `dart pub publish`, adding `--force` in CI.
