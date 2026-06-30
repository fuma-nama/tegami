#!/usr/bin/env node
import { tegami } from "tegami";
import { runCli } from "tegami/cli";
import { github } from "tegami/plugins/github";
import { x } from "tinyexec";

const paper = tegami({
  plugins: [
    {
      name: "auto-format",
      enforce: "post",
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
  groups: {
    tegami: {
      syncBump: true,
      syncGitTag: true,
      prerelease: "beta",
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
