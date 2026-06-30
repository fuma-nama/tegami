---
name: migrate-from-changesets
description: >-
  Migrate a repository's release tooling from @changesets/cli to Tegami —
  install and configure Tegami, convert pending changesets, rewrite CI, remove
  Changesets, and validate the new pipeline with a dry run. Use when a repo
  currently uses Changesets and wants to switch to Tegami for versioning and
  publishing.
license: MIT
---

# Migrate from Changesets to Tegami

A field-tested, end-to-end procedure for replacing [`@changesets/cli`](https://github.com/changesets/changesets) with [Tegami](https://tegami.fuma-nama.dev). The official reference is [Migrating from Changesets](https://tegami.fuma-nama.dev/migrating-from-changesets); this skill is the _procedure_ — the ordered steps, the validation technique, and the non-obvious traps — for an agent driving the migration in someone's repo.

## When to use

The repo has a `.changeset/` directory and `@changesets/cli` in `devDependencies`, and the user wants to move to Tegami. Works for npm, Cargo, and mixed monorepos; the examples below assume a pnpm workspace (swap in your package manager as needed).

## Before you start — survey the existing setup

Don't write anything yet. First read what Changesets is doing, because every option maps to a Tegami equivalent:

```bash
cat .changeset/config.json          # access, baseBranch, ignore, fixed, linked, privatePackages
ls .changeset/*.md                  # pending changesets to convert (README.md is not one)
cat .github/workflows/*.yml | grep -l changeset   # the release workflow(s)
grep -rn "changeset" package.json scripts/        # npm scripts + any custom version/publish helpers
```

Note in particular:

- **Which packages actually publish.** Often only one package in a monorepo is public; the rest are `private` and merely versioned. Tegami versions private packages by default but never publishes them.
- **Any custom post-version script** (e.g. a `sync-versions` step that force-aligns every `package.json` to one version). These usually become a Tegami **package group** (see step 5).
- **How the workflow authenticates to npm** — an `NPM_TOKEN` secret vs OIDC trusted publishing (`id-token: write`, no token). This drives a critical gotcha below.

## Steps

### 1. Install Tegami

```bash
pnpm add -D -w tegami     # npm install tegami -D / bun add -D tegami
```

Requires Node.js 24+.

### 2. Create the config script

Tegami is configured by a Node script, not a JSON file. Copy [`templates/tegami.mts`](templates/tegami.mts) to `scripts/tegami.mts` and edit `repo`, the registry `client`, and the base branch. Add a package script:

```json
{ "scripts": { "tegami": "node scripts/tegami.mts" } }
```

Invoke it as `pnpm tegami` (the npm script runs the config under Node). Tegami also runs fine under Bun (`bun scripts/tegami.mts`) — see gotchas.

### 3. Map `.changeset/config.json` to `tegami()` options

| Changesets `config.json`         | Tegami                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| `access`                         | `publishConfig.access` in each `package.json`                                        |
| `baseBranch`                     | `github({ versionPr: { base } })`                                                    |
| `ignore`                         | `ignore: [names \| /regex/]`                                                         |
| `fixed` / `linked`               | a `group` with `syncBump` / `syncGitTag` (step 5)                                    |
| `updateInternalDependencies`     | `npm.bumpDep`                                                                        |
| `privatePackages.version: false` | add those private packages to `ignore` (Tegami versions private packages by default) |

### 4. Convert pending changesets

Only convert changesets that have **not** been released yet. For each `.changeset/*.md`, rewrite into `.tegami/*.md`: move the package keys under a `packages:` frontmatter field, and ensure the body has at least one `#`/`##`/`###` heading.

```md
---
packages:
  my-pkg: patch
---

## Summary of the change
```

### 5. (Optional) Keep packages on one shared version

If the old setup force-aligned every package to a single version (a custom `sync-versions` script, or Changesets `fixed`), replace it with one group that every package joins via `syncBump`:

```ts
groups: { all: { syncBump: true } },
packages: () => ({ group: 'all' }),
```

`syncBump` applies the **same bump type** to all members, so they stay aligned **only if they already share a version today** — verify that first (`grep '"version"' **/package.json`). It does **not** force identical version _strings_ the way a sync script does; a package that has drifted won't snap back on its own.

### 6. Replace the CI workflow

Delete the Changesets release workflow and add [`templates/release.yml`](templates/release.yml): it runs `tegami ci` on pushes to the main branch (version when changelogs are pending → opens a Version Packages PR; otherwise publish from the committed lock). Optionally add the PR release-preview pair [`templates/tegami-pr.yml`](templates/tegami-pr.yml) + [`templates/tegami-pr-comment.yml`](templates/tegami-pr-comment.yml) (a capability Changesets needed its GitHub App for).

**Version in the PR title.** Changesets workflows often put the release version in the Version Packages PR title (`chore: release v1.2.3`). Tegami's `github` plugin doesn't by default — restore it with the `versionPr.create()` hook in `scripts/tegami.mts`, where `this` is the `TegamiContext` (so `this.graph` is available):

```ts
github({
  repo: 'your-org/your-repo',
  versionPr: {
    base: 'main',
    create() {
      // `create` runs AFTER the draft is applied, so the graph already holds the
      // bumped versions — read the new version straight off the published package.
      // With a shared-version group, any member works.
      const version = this.graph.get('npm:your-package')?.version;
      return { title: version ? `chore: release v${version}` : 'chore: release' };
    },
  },
}),
```

> **Pitfall:** don't compute the version with `draft.getPackageDraft(id)?.bumpVersion(pkg)` here. `create` fires _after_ the draft is applied, so the graph package is already bumped — re-bumping it double-counts (e.g. titles the PR `v0.21.0` while it actually bumps to `v0.20.0`). Read `this.graph.get(id)?.version` instead.

`create()` must be a method (or `function`), not an arrow, so `this` binds to the context. It only reads a version — no markdown rendering — so it's safe under any runtime. Note it sets the title at PR-creation time; an already-open Version Packages PR keeps its old title until the next run updates it.

### 7. Validate with a dry run — _before removing Changesets_

This is the most important step and the technique most people miss. Tegami has no global `version --dry-run`, so simulate a release and revert it:

```bash
# back up the pending changelogs first — `version` consumes (deletes) them
cp .tegami/*.md /tmp/tegami-backup/ 2>/dev/null || true

pnpm tegami version            # inspect the release plan it prints
grep '"version"' **/package.json  # confirm the bumps are what you expect
head -20 path/to/published/CHANGELOG.md  # confirm the changelog output
pnpm tegami publish --dry-run  # validate the publish lock end-to-end

# revert everything the dry run touched, keeping your config edits
git checkout -- . ':(exclude)scripts/tegami.mts'
rm -f .tegami/publish-lock.yaml
cp /tmp/tegami-backup/*.md .tegami/ 2>/dev/null || true
pnpm install                   # restore the lockfile
```

Confirm: the right packages bump, only publishable packages appear in the publish plan, and no stray `CHANGELOG.md` files are generated for private packages.

### 8. Remove Changesets

```bash
pnpm remove @changesets/cli              # npm remove / bun remove
git rm -r .changeset
git rm .github/workflows/<changesets-workflow>.yml
git rm scripts/<custom-sync-script>      # if any (now handled by the group)
```

Remove the `changeset*` npm scripts from `package.json`. Then delete **empty placeholder `CHANGELOG.md` files** in private packages — they exist only because Changesets created them; Tegami writes a changelog only for packages that actually receive notes, and creates the file fresh if one ever does. Keep real changelogs (the published package's, and any root redirect).

### 9. (Optional) Backfill missing changelogs

If commits landed since the last release without a changeset, add `.tegami/*.md` entries for the user-facing ones so they appear in the next release. Find them with `git log <last-tag>..HEAD` and check which touch the published package's source.

### 10. Teach contributors and agents

Run `tegami init-agent` to append changelog instructions to `AGENTS.md`, and update `CONTRIBUTING.md` (replace "add a changeset" with "run `tegami`").

## Gotchas (field-tested)

- **npm trusted publishing is pinned to the workflow filename.** If the old workflow published via OIDC (`id-token: write`, no `NPM_TOKEN`), npm's trusted-publisher config names the _old_ workflow file. Renaming the workflow (e.g. `changesets.yml` → `release.yml`) **breaks publishing** until you update the trusted publisher on npmjs.com to the new filename. This is the easiest thing to forget.
- **Bun works, even though every doc example uses pnpm/npm.** Set `npm: { client: 'bun' }`. Tegami runs `prepack`/`prepare` via `bun run`, packs with `bun pm pack`, and publishes the tarball with `npm publish` (so OIDC/provenance still work).
- **`syncBump` ≠ Changesets `linked`.** It equalizes the bump _delta_, not the version _string_. Only reliable when members already share a version.
- **Release tag format is `<pkg-name>@<version>`** (or `<group>@<version>` with `syncGitTag`). If other workflows parse release tags (e.g. a post-release smoke test), confirm the format still matches.
- **Private packages are versioned by default.** To exclude them entirely (the Changesets `privatePackages.version: false` behavior), add them to `ignore`.
- **`tegami ci` on an empty repo state is a safe no-op** — no pending changelogs and no publish lock means it does nothing, so merging the migration PR won't accidentally publish.
- **The Changesets _GitHub App_ (`changeset-bot`) is separate from the workflow.** Deleting `.changeset/` and the workflow does not stop the `changeset-bot[bot]` "⚠️ No Changeset found" PR comments — that's an account-level App installation. It keeps commenting on every PR (harmless but confusing, and easy to mistake for Tegami) until you uninstall it: github.com/settings/installations → **changeset-bot** → remove the repo or uninstall.

## Cleanup checklist

- [ ] `.changeset/` removed
- [ ] `@changesets/cli` removed from `devDependencies`
- [ ] `changeset*` npm scripts removed
- [ ] Changesets release workflow removed; `release.yml` added
- [ ] `changeset-bot` GitHub App uninstalled (stops "No Changeset found" PR comments)
- [ ] Custom sync/version scripts removed (replaced by a group if needed)
- [ ] Empty placeholder `CHANGELOG.md` files removed
- [ ] npm trusted-publisher workflow filename updated
- [ ] `CONTRIBUTING.md` / `AGENTS.md` updated
- [ ] Dry run (step 7) passed and was reverted
- [ ] `grep -rin changeset` returns only historical `CHANGELOG.md` entries
