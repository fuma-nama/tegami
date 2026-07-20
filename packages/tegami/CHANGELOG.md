## tegami@1.2.6

### Preserve interactive registry authentication

Registry publishing now retains terminal access during local interactive runs, allowing browser and two-factor authentication to complete before publishing continues.

## tegami@1.2.5

### Fix `ci` command order problem

The `ci` now correctly prioritize versioning over publishing.

## tegami@1.2.4

### No longer add `enforce`

Built-in plugins no longer add `enforce`, this ensures custom plugins always take priority in ordering.

### Support reason field in publish status

Introduce a new `getPublishStatus` method that returns reason for why the task is pending.

## tegami@1.2.3

### Sort release preview packages by bump severity

GitHub PR release previews and Version Packages pull requests now list packages by version delta, largest bump first.

### Support aube and nub in npm releases

The npm plugin now detects aube and nub projects, discovers aube workspaces, refreshes their lockfiles without relinking `node_modules`, and publishes with the matching package manager command.

### Remove publish plan check from changelog TUI

Since adding new changelogs will no longer interfere with publishing, it is safe to skip the checks.

## tegami@1.2.2

### Improve lockfile command

## tegami@1.2.1

### Support custom commit messages

### Improve error messages for HTTP requests

## tegami@1.2.0

### Fix npm workspace protocol matching

In general, workspace protocol should assume ranges to include prerelease.

### Redesign Publish Groups

The Version PRs will now display published packages based on preflight results, rather than updated packages only.

## tegami@1.1.3

### Split version requests by publish group

GitHub and GitLab version requests now split grouped packages into separate release PRs or MRs, with ungrouped packages published from a separate request.

### Preserve formatting of pnpm-workspace file

### Support Partial Publishing

Only publish a subset of bumped packages.

### Support concurrent publishing

Automatically publish independent packages concurrently.

## tegami@1.1.2

### Fix update lock file of npm plugin

### Support catalog for npm plugin

Tegami can now bump deps correctly with catalog protocol.

## tegami@1.1.1

### Replace `js-yaml` with `yaml`

`yaml` supports preserving formatting while editing properties, this is useful for updating package manifest files.

### Experiment `typia` compile-time validation

Try to precompile schema using `typia`.

## tegami@1.1.0

### Improve Cargo performance by pre-indexing dependencies

The dependencies of `Cargo.toml` will be pre-indexed to improve performance in large monorepos.

### Support `prerelease(name)` replay condition

Tegami now supports replay condition when entering prerelease.

## tegami@1.0.2

### Handle Cargo workspace semantics

Tegami can now handle more advanced workspace inheritance usages.

### Support `afterPreflight` hook

Hook when all preflights finished.

## tegami@1.0.0

### Make Cargo plugin opt-in

The Cargo plugin is no longer enabled by default. Add `cargo()` from `tegami/plugins/cargo` to your `plugins` array for Rust workspace support.

### Support `npm pretrust` command

Useful for publishing new packages with trusted publishing.

### v1 stable

This marks all v1 APIs as stable.

### Generate dist tag for npm in prerelease mode

`npm publish` now requires `tag` for prerelease versions.

### Plugin `afterPublish` no longer fired for skipped packages

The `afterPublish` hook of plugins will no longer be fired for skipped packages.

### Add support for Golang

Experimental plugin available at `/plugins/go`.

### Ready for v1

This marks all existing APIs as stable & safe to use.

### Support function `packages` option

The `packages` option can now return package options dynamically.

### Include packages without `version`

Previously, packages without a version field defined in `package.json` or `Cargo.toml` will be ignored from graph, now those packages will be included.

This may add unwanted packages into versioning, please update your `ignore` config if needed.

### Fix prerelease tag switching

Switch prerelease tag without triggering another bump.

### Auto replay when prerelease is configured

No longer need to write replay conditions manually.

### Handle empty `version` fields in `Cargo.toml` & `package.json`

No longer bump versions when `version` field is not defined.

### Fix replaying changelogs showing in PR body

No longer show replay-only changelogs in PR previews.

### Show bumped packages of each changelog

The PR preview body now show the bumped packages of each changelog, in a collapsible.

### Change behaviour of `publishPreflight` hook

Now only the first handler plugin will be considered, no longer merges results.

### Replace `preflight.publish` with `preflight.shouldPublish`

The publish checking will only happen at publish-time & plan resolve.

### Fix CLI parsing for options without short flags

Release preview workflows failed when passing `--artifact` because Node's argument parser rejects `short: undefined`.

### Improve GitHub release notes

The release notes can now display related PRs & contributors.

### Support `go.publish` option

Decide whether a Go package should be published via the `go.publish` option, default to `true`.

### Drop MDAST dependencies

Tegami only requires extracting headings and preserves formatting, a regex alternative is lighter, better, and faster.

### Remove dependency for parsing

Replace extra dependencies with `util:parseArgs`.

### Add GitLab plugin

Tegami now includes a GitLab plugin with version merge requests, GitLab releases, tag handling, and release note links for commits and related merge requests.

### Allow plugins to add CLI commands

Plugins can now hook on `runCli` hook to add custom commands.

### Strict checks for Git tags

Handle concurrent runs & without `git pull`.

### Support `no-checks` option in `version` command

Allows to skip publish plan status checks.

### Move request preview commands into plugins

The GitHub plugin now provides `tegami pr`, and the GitLab plugin provides `tegami mr` for merge request previews and comments.

Plugin CLI commands now register through the `initCli` hook, so `tegami --help` and grouped help output include plugin-provided commands.

### Add pip plugin

Tegami now includes an opt-in pip plugin at `@tegami/pip` for Python monorepos. It discovers packages from `pyproject.toml`, supports uv workspaces, bumps dependency ranges, runs `uv lock` after versioning, and publishes to PyPI with `uv publish`.

## tegami@1.0.0-beta.5 (beta)

### Fix CLI parsing for options without short flags

Release preview workflows failed when passing `--artifact` because Node's argument parser rejects `short: undefined`.

### Strict checks for Git tags

Handle concurrent runs & without `git pull`.

### Support `no-checks` option in `version` command

Allows to skip publish plan status checks.

### Add pip plugin

Tegami now includes an opt-in pip plugin at `@tegami/pip` for Python monorepos. It discovers packages from `pyproject.toml`, supports uv workspaces, bumps dependency ranges, runs `uv lock` after versioning, and publishes to PyPI with `uv publish`.

## tegami@1.0.0-beta.4 (beta)

### Remove dependency for parsing

Replace extra dependencies with `util:parseArgs`.

### Allow plugins to add CLI commands

Plugins can now hook on `runCli` hook to add custom commands.

### Move request preview commands into plugins

The GitHub plugin now provides `tegami pr`, and the GitLab plugin provides `tegami mr` for merge request previews and comments.

Plugin CLI commands now register through the `initCli` hook, so `tegami --help` and grouped help output include plugin-provided commands.

## tegami@1.0.0-beta.3 (beta)

### Improve GitHub release notes

The release notes can now display related PRs & contributors.

### Support `go.publish` option

Decide whether a Go package should be published via the `go.publish` option, default to `true`.

### Drop MDAST dependencies

Tegami only requires extracting headings and preserves formatting, a regex alternative is lighter, better, and faster.

### Add GitLab plugin

Tegami now includes a GitLab plugin with version merge requests, GitLab releases, tag handling, and release note links for commits and related merge requests.

## tegami@1.0.0-beta.2 (beta)

### Change behaviour of `publishPreflight` hook

Now only the first handler plugin will be considered, no longer merges results.

### Replace `preflight.publish` with `preflight.shouldPublish`

The publish checking will only happen at publish-time & plan resolve.

## tegami@1.0.0-beta.1 (beta)

### Handle empty `version` fields in `Cargo.toml` & `package.json`

No longer bump versions when `version` field is not defined.

### Fix replaying changelogs showing in PR body

No longer show replay-only changelogs in PR previews.

### Show bumped packages of each changelog

The PR preview body now show the bumped packages of each changelog, in a collapsible.

## tegami@1.0.0-beta.0 (beta)

### Generate dist tag for npm in prerelease mode

`npm publish` now requires `tag` for prerelease versions.

### Plugin `afterPublish` no longer fired for skipped packages

The `afterPublish` hook of plugins will no longer be fired for skipped packages.

### Add support for Golang

Experimental plugin available at `/plugins/go`.

### Ready for v1

This marks all existing APIs as stable & safe to use.

### Support function `packages` option

The `packages` option can now return package options dynamically.

### Include packages without `version`

Previously, packages without a version field defined in `package.json` or `Cargo.toml` will be ignored from graph, now those packages will be included.

This may add unwanted packages into versioning, please update your `ignore` config if needed.

### Fix prerelease tag switching

Switch prerelease tag without triggering another bump.

### Auto replay when prerelease is configured

No longer need to write replay conditions manually.

## tegami@0.2.1

### Fix failing checks for Git tags

Fixed a bug that causes publish plan status checking to fail.

### Fix lifecycle hooks for Bun

Tegami used `bun pm pack` workaround for Bun, but it doesn't run lifecycle hooks. Tegami now runs the hooks same as other setups.

## tegami@0.2.0

### Redesign GitHub plugin options

GitHub release and Version Packages PR settings are now top-level options:

- `eagerRelease` → `release: { eager: true }`
- `onCreateRelease` → `release.create`
- `onCreateGroupedRelease` → `release.createGrouped`
- `onCreateVersionPullRequest` → `versionPr.create`
- `cli.versionPr` → `versionPr` (use `forceCreate: true` to enable locally)

Set `release: false` to disable GitHub release creation.

### Add `check-publish` CLI command

`tegami check-publish` checks whether a publish lock has packages waiting to be published. It exits `0` when publishing is needed and `1` when it is not, so CI workflows can skip unnecessary steps without actually trying to publish packages.

```bash
if tegami check-publish; then
  # other commands
fi
```

### Use HTTP APIs instead of CLI tools

GitHub releases, pull requests, and comments now use the GitHub REST API instead of the `gh` CLI. npm publish preflight checks the registry over HTTP instead of running `npm view` or `pnpm view`.

Git operations and package publishing still use their respective CLI tools.

### Lock files update by default

`updateLockFile` now defaults to `true` for the npm and Cargo providers. Lockfiles are refreshed automatically after versioning unless you set `updateLockFile: false`.

### v0.2 redesign

Tegami 0.2 separates versioning from publishing and renames several core types.

### Publish lock replaces the publish plan file

`tegami version` now writes `.tegami/publish-lock.yaml` instead of a JSON publish plan file.

- Config option `planPath` is now `lockPath` (default: `.tegami/publish-lock.yaml`).
- The lock uses YAML namespaces (`core:packages`, `core:changelogs`, `npm:packages`, …) instead of a single JSON document.
- Packages must have `updated: true` in the lock to be published. New packages added after versioning are excluded until the next release cycle.

### Draft and publish plan API

| v0.1                          | v0.2                                                                 |
| ----------------------------- | -------------------------------------------------------------------- |
| `DraftPlan`                   | `Draft`                                                              |
| `PackagePlan`                 | `PackageDraft`                                                       |
| `createDraftPlan()`           | `createDraft()`                                                      |
| `draft.getPackagePlans()`     | `draft.getPackageDrafts()`                                           |
| JSON `PlanStore` on disk      | `PublishLock` YAML on disk + in-memory `PublishPlan` at publish time |
| `publish()` → `PublishResult` | `publish()` → `PublishPlan \| "skipped"`                             |
| `cleanupPublishPlan()`        | `cleanupPublishLock()`                                               |

`PublishPlan` is built in memory when you call `publish()`. It is not written to disk.

### Plugin hook renames

| v0.1                     | v0.2                                                    |
| ------------------------ | ------------------------------------------------------- |
| `initPlan`               | `initDraft`                                             |
| `applyPlan`              | `applyDraft`                                            |
| `cli.publishPlanCreated` | `cli.draftCreated`                                      |
| `cli.publishPlanApplied` | `cli.draftApplied`                                      |
| `createRegistryClient`   | removed — use `publishPreflight` / `publish` on plugins |
| `RegistryClient`         | removed                                                 |

New hooks:

- `initPublishLock` — write plugin data into the publish lock when a draft is applied.
- `initPublishPlan` — enrich the in-memory publish plan from the lock (e.g. git tags, npm dist-tags).
- `publishPreflight` — check registries and declare publish order before publishing.
- `resolvePlanStatus` — report whether post-publish work (git tags, GitHub releases) is complete.

`resolvePlanStatus`, `afterPublish`, and `afterPublishAll` now receive a `PublishPlan` instead of `PublishResult` / `PlanStore`.

### LogGenerator

Custom changelog generators now receive `{ pkg, packageDraft, draft }` instead of `{ packageId, packageName, version, changelogs, plan, unstable_draft }`.

### Package options

`packages.<name>.publish` was removed from Tegami config. Control npm publishing with `private: true` or `publishConfig` in `package.json` instead.

### GitHub plugin

GitHub release and Version Packages PR options moved to the top level:

- `eagerRelease` → `release: { eager: true }`
- `onCreateRelease` → `release.create`
- `onCreateGroupedRelease` → `release.createGrouped`
- `onCreateVersionPullRequest` → `versionPr.create`
- `cli.versionPr` → `versionPr` (use `forceCreate: true` to enable locally)

Release callbacks now receive `{ tag, pkg, plan }` (or grouped equivalents) instead of `PackagePublishResult`. Set `release: false` to disable GitHub releases.

### Support `conventionalCommits` option

When enabled, it generates changelogs from commits when you run `tegami version`.

## tegami@0.1.6

### Check GitHub release before creating

Prevent errors from conflicts.

### `tegami pr comment` will ignore if there is no related PR

## tegami@0.1.5

### Use absolute path for `bun pm pack`

Somehow they're using project root and do not respect cwd at all.

## tegami@0.1.4

### Fix handling for `undefined` bump types

No longer cause unnecessary bumps for packages in prerelease.

### Support group-level `npm` config

Groups can now define `npm` config for member packages.

## tegami@0.1.3

### Hotfix error in GitHub plugin

## tegami@0.1.2

### Fix missing bump for changed prerelease option

Now, all changes to script-level package options (such as `prerelease`) will result in an update event, which ensures dependents are bumped correctly.

### Use preferred package manager for publishing

This ensures the pm-specific protocols like `workspace:` are respected.

### Support `replay` in changelog files

This allows changelog files to be replayed when a certain version released, this is useful if you want to replay changelogs when the first stable version lands, collecting changelogs from previous beta releases.

### Generate `replay` automatically

When creating changelogs via `tegami` command, it will generate `replay` attribute automatically for packages in prerelease.

### Support creating GitHub release eagerly

Without waiting for other packages, published packages will create a GitHub release.

## tegami@0.1.1

### Fix error handling

Report command errors correctly with more details.

### Support update lock file for Cargo

The Cargo plugin can now update lock file after applying publish plan.

### Support publish preflights

Publish preflights allow registry clients to wait for other packages before publishing, this is required for package managers like Cargo where the order matters.

## tegami@0.1.0

### Fix generated link

The create file link in PR was wrong for `pr preview` command.

### Preserve Cargo.toml formatting

Cargo manifest edits now use `@rainbowatcher/toml-edit-js` instead of re-stringifying the whole file, so comments and formatting are kept when bumping versions or dependency ranges.

### Allow specifying bump type per-package

The `tegami` command can now specify bump type per-package instead of for all.

## tegami@0.1.0-beta.4

### Replace `ci-pr` command with `pr`

This will break previous usages, please migrate to the `pr` command (see docs).

### Rename `afterPublish` to `afterPublishAll`, and add package-level `afterPublish` hook

`willPublish` & `afterPublish` can now override/control the publishing process.

## tegami@0.1.0-beta.3

### Improve conventional commit parsing

### Support init-agent command

Consumer can run `tegami init-agent` command to generate configs for agents.

### fix local version command

require `forceCreate` option when an object is specified.

### Prioritize changed packages in changelog picker

Packages with git changes now appear first in the interactive package selector, with a `changed` hint.

## tegami@0.1.0-beta.2

### Support better changelog design

### Improve changelog & PR styles

### Improve TUI for adding changelogs

Add search + group selection support

## tegami@0.1.0-beta.1

### Improve CI integration

Add `ci` command and will publish hooks.

## tegami@0.1.0-beta.0

### Minor beta

## 0.0.1

### Test

The first beta release of Tegami.
