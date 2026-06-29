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
  packages: {
    tegami: {
      prerelease: "beta",
    },
  },
});

await runCli(paper);
