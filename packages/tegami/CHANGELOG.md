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
