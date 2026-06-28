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
