#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tegami } from "tegami";
import { createCli } from "tegami/cli";
import { github } from "tegami/plugins/github";

const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await createCli(
  tegami({
    cwd,
    plugins: [
      github({
        repo: "fuma-nama/tegami",
      }),
    ],
    packages: {
      "npm:tegami": {
        prerelease: "beta",
      },
    },
  }),
).parseAsync();
