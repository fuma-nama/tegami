#!/usr/bin/env node
import { tegami } from "tegami";
import { runCli } from "tegami/cli";
import { github } from "tegami/plugins/github";
import { x } from "tinyexec";

const paper = tegami({
  plugins: [
    {
      name: "custom",
      async willPublish({ pkg }) {
        console.log("building", pkg.name);
        await x("pnpm", ["build", "--filter", pkg.name], {
          throwOnError: true,
        });
      },
      async applyCliDraft() {
        await x("pnpm", ["format"], {
          throwOnError: true,
        });
      },
    },
    github({
      repo: "fuma-nama/tegami",
      versionPr: {
        base: "dev",
      },
    }),
  ],
  npm: {
    trustedPublish: {
      provider: "github",
      workflow: "publish.yml",
    },
  },
  groups: {
    tegami: {
      syncBump: true,
      syncGitTag: true,
    },
  },
  packages: {
    tegami: {
      group: "tegami",
    },
    "@tegami/pip": {
      group: "tegami",
    },
  },
});

await runCli(paper);
