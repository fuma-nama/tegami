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
