// scripts/tegami.mts — Tegami versioning + publishing config.
//
// Run via a package script: { "tegami": "node scripts/tegami.mts" }
// and invoke as `pnpm tegami` (or `bun scripts/tegami.mts` in a Bun repo).
import { tegami } from 'tegami';
import { createCli } from 'tegami/cli';
import { github } from 'tegami/plugins/github';

const paper = tegami({
  // Exclude packages from the version graph entirely. Use this for private
  // packages you don't want versioned (the Changesets `privatePackages.version:
  // false` / `ignore` behavior). Accepts names, package ids, or RegExp.
  // ignore: [/^@acme\/internal/, 'some-private-pkg'],

  // OPTIONAL — keep every package on one shared version (replaces a custom
  // sync-versions script or Changesets `fixed`). Only keeps them aligned if
  // they already share a version today; `syncBump` equalizes the bump delta,
  // not the version string. Drop `ignore` if you group everything.
  // groups: { all: { syncBump: true } },
  // packages: () => ({ group: 'all' }),

  npm: {
    // 'pnpm' | 'npm' | 'yarn' | 'bun' — match your repo's package manager.
    client: 'pnpm',
  },

  plugins: [
    github({
      repo: 'your-org/your-repo',
      versionPr: {
        base: 'main',

        // OPTIONAL — put the release version in the Version Packages PR title
        // (e.g. "chore: release v1.2.3"), like the old Changesets workflow.
        // Must be a method (not an arrow) so `this` binds to the TegamiContext.
        // create({ draft }) {
        //   const pkg = this.graph.get('npm:your-package');
        //   const version = pkg ? draft.getPackageDraft('npm:your-package')?.bumpVersion(pkg) : undefined;
        //   return { title: version ? `chore: release v${version}` : 'chore: release' };
        // },
      },
    }),
  ],
});

void createCli(paper).parseAsync();
