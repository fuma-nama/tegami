#!/usr/bin/env node
import { tegami } from "tegami";
import { createCli } from "tegami/cli";
import { github } from "tegami/plugins/github";

const paper = tegami({
  plugins: [
    github({
      repo: "fuma-nama/tegami",
      cli: {
        versionPr: {
          base: "dev",
        },
      },
    }),
  ],
});

await createCli(paper).parseAsync();
