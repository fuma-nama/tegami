#!/usr/bin/env node
import { tegami } from "tegami";
import { createCli } from "tegami/cli";
import { github } from "tegami/plugins/github";
import { x } from "tinyexec";

const paper = tegami({
  plugins: [
    {
      name: "auto-format",
      cli: {
        async draftApplied() {
          await x("pnpm", ["format"], {
            throwOnError: true,
          });
        },
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

await createCli(paper).parseAsync();
