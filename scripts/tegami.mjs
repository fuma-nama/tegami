#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tegami } from "../packages/tegami/dist/index.mjs";
import { createCli } from "../packages/tegami/dist/cli/index.mjs";
import { github } from "../packages/tegami/dist/plugins/github.mjs";

const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await createCli(
  tegami({
    cwd,
    plugins: [
      github({
        repo: "fuma-nama/tegami",
      }),
    ],
  }),
).parseAsync();
