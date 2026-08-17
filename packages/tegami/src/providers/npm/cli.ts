import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { intro, note, outro } from "@clack/prompts";
import { x } from "tinyexec";
import type { TegamiCliRegistry } from "../../cli/core";
import type { TegamiContext } from "../../context";
import { initPublishPlan, planConcurrency, runPreflights } from "../../plans/publish";
import { execFailure } from "../../utils/error";
import { NpmPackage } from "../npm";
import { fetchPackument } from "./registry";
import { runConcurrent } from "../../utils/common";
import { parsePublishLock, type PublishLock } from "../../plans/lock";

const PLACEHOLDER_VERSION = "0.0.0-tegami-trusted-publish-setup";
const PLACEHOLDER_DIST_TAG = "temp";

export type TrustedPublishOptions =
  | {
      provider: "github";
      /** CI workflow filename for publishing. */
      workflow: string;
    }
  | {
      provider: "gitlab";
      /** CI pipeline filename for publishing. */
      workflow: string;
    };

const PROJECT_FLAG = {
  gitlab: "--project",
  github: "--repo",
} as const;

export function registerNpmCli(cli: TegamiCliRegistry, options: TrustedPublishOptions): void {
  cli
    .command("npm pretrust", {
      description:
        "publish empty placeholder packages and configure npm trusted publishing for new packages",
    })
    .option("dry-run", {
      type: "boolean",
      description: "show packages that would be configured without publishing",
    })
    .action(async ({ context, values }) => {
      intro("npm pretrust");

      if (!context.graph.getPackages().some((pkg) => pkg instanceof NpmPackage)) {
        throw new Error("No npm packages found in the workspace.");
      }

      const dryRun = values["dry-run"] ?? false;
      let repo: string;
      if (options.provider === "github") {
        if (!context.github?.repo)
          throw new Error("The GitHub plugin must be configured with `repo` specified.");

        repo = context.github.repo;
      } else if (options.provider === "gitlab") {
        if (!context.gitlab?.repo)
          throw new Error("The GitLab plugin must be configured with `repo` specified.");

        repo = context.gitlab.repo;
      } else {
        // @ts-expect-error -- no other providers
        throw new Error(`Invalid npm trusted publishing provider: ${options.provider}`);
      }

      const { targets, unsupported } = await resolvePretrustTargets(context);
      if (unsupported.length > 0) {
        note(
          `${unsupported.join("\n")}\n\nnpm trusted publishing only exists on registry.npmjs.org.`,
          "Skipped",
        );
      }

      if (targets.length === 0) {
        outro("Every remaining package already exists on npm.");
        return;
      }

      const prepareLines: string[] = [
        "Make sure to run login command first, it will publish empty packages.",
      ];
      for (const pkg of targets) {
        prepareLines.push(
          `${pkg.name}: will publish a placeholder under dist-tag "${PLACEHOLDER_DIST_TAG}", then configure trusted publishing.`,
        );
      }
      note(prepareLines.join("\n"), dryRun ? "Dry run" : "Configure trusted publishing");

      const lines: string[] = [];
      let lock: PublishLock | undefined;
      if (!dryRun)
        try {
          lock = parsePublishLock(await fs.readFile(context.lockPath, "utf8"));
        } catch {}

      for (const pkg of targets) {
        if (dryRun) {
          lines.push(
            `would configure ${pkg.name} (placeholder ${PLACEHOLDER_VERSION}@${PLACEHOLDER_DIST_TAG})`,
          );
          continue;
        }

        await publishPlaceholder(pkg);
        await npmTrust(context, pkg, options, repo);
        lines.push(
          `configured ${pkg.name} (placeholder ${PLACEHOLDER_VERSION}@${PLACEHOLDER_DIST_TAG})`,
        );
        lock?.write("npm:mark-latest", {
          id: pkg.id,
        });
      }

      if (lock) await fs.writeFile(context.lockPath, lock.serialize());
      note(lines.join("\n"), "Result");
      outro(
        dryRun
          ? "Dry run complete. Re-run without --dry-run to publish placeholders and configure trusted publishing."
          : "Trusted publishing configured. CI can now publish real package versions with OIDC.",
      );
    });
}

interface PretrustTargets {
  /** publishable packages npm does not know yet */
  targets: NpmPackage[];
  /** packages left out because their registry has no trusted publishing */
  unsupported: string[];
}

async function resolvePretrustTargets(context: TegamiContext): Promise<PretrustTargets> {
  const plan = await initPublishPlan(context, {});
  if (!plan) {
    throw new Error(
      `No publish lock found at ${context.lockPath}. Run "tegami version" before configuring trusted publishing.`,
    );
  }

  await runPreflights(context, plan);

  const candidates: NpmPackage[] = [];
  const unsupported: string[] = [];
  for (const [id, { preflight }] of plan.packages) {
    if (!preflight?.shouldPublish) continue;
    const pkg = context.graph.get(id);
    if (!(pkg instanceof NpmPackage)) continue;

    switch (pkg.getRegistry()) {
      case "https://registry.npmjs.org":
      case "http://registry.npmjs.org":
        candidates.push(pkg);
        break;
      default:
        unsupported.push(pkg.name);
    }
  }

  const targets = (
    await runConcurrent(candidates, planConcurrency(plan), async (pkg) =>
      (await fetchPackument(pkg)) ? undefined : pkg,
    )
  ).filter((pkg) => pkg !== undefined);

  return { targets, unsupported };
}

async function publishPlaceholder(pkg: NpmPackage): Promise<void> {
  const registry = pkg.getRegistry();
  const access = pkg.manifest.publishConfig?.access;

  const dir = await fs.mkdtemp(join(tmpdir(), "tegami-npm-placeholder-"));
  try {
    await Promise.all([
      fs.writeFile(
        join(dir, "package.json"),
        `${JSON.stringify(
          {
            name: pkg.name,
            version: PLACEHOLDER_VERSION,
            description: "Placeholder published by Tegami for npm trusted publishing setup.",
          },
          null,
          2,
        )}\n`,
      ),
      fs.writeFile(
        join(dir, "README.md"),
        `# Placeholder package
  
  This empty package was published by [Tegami](https://tegami.fuma-nama.dev) to configure npm trusted publishing.
  
  The real package contents will be published via CI with OIDC.
  `,
      ),
    ]);

    const args = [
      "publish",
      "--tag",
      PLACEHOLDER_DIST_TAG,
      "--ignore-scripts",
      "--registry",
      registry,
    ];
    if (access) args.push("--access", access);

    const result = await x("npm", args, {
      nodeOptions: { cwd: dir, stdio: "inherit" },
    });
    if (result.exitCode !== 0) {
      const hint = result.stderr.includes("EOTP")
        ? " Complete npm 2FA in the terminal, or publish with an OTP-capable session."
        : "";
      throw execFailure(
        `Failed to publish placeholder ${pkg.name}@${PLACEHOLDER_VERSION} with dist-tag "${PLACEHOLDER_DIST_TAG}".${hint}`,
        result,
      );
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function npmTrust(
  context: TegamiContext,
  pkg: NpmPackage,
  options: TrustedPublishOptions,
  repo: string,
): Promise<void> {
  const args = [
    "trust",
    options.provider,
    pkg.name,
    PROJECT_FLAG[options.provider],
    repo,
    "--file",
    options.workflow,
    "--allow-publish",
    "-y",
    "--registry",
    pkg.getRegistry(),
  ];

  const result = await x("npm", args, {
    nodeOptions: { cwd: context.cwd, stdio: "inherit" },
  });
  if (result.exitCode !== 0) {
    const hint = result.stderr.includes("EOTP")
      ? " Complete npm 2FA in the terminal when prompted."
      : "";
    throw execFailure(`Failed to configure trusted publishing for ${pkg.name}.${hint}`, result);
  }
}
