#!/usr/bin/env node
import { tegami } from "tegami";
import { createCli } from "tegami/cli";
import { github } from "tegami/plugins/github";

const paper = tegami({
  plugins: [
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
