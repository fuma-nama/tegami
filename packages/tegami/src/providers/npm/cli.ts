import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { intro, note, outro, spinner } from "@clack/prompts";
import { x } from "tinyexec";
import type { TegamiCliRegistry } from "../../cli/core";
import type { TegamiContext } from "../../context";
import { initPublishPlan, runPreflights } from "../../plans/publish";
import { execFailure } from "../../utils/error";
import { NpmPackage } from "../npm";
import { joinPath } from "../../utils/common";

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

      const targets = await resolvePretrustTargets(context);
      if (targets.length === 0) {
        outro("All publishable packages in the publish lock already exist on npm.");
        return;
      }

      note(
        targets
          .map(
            (pkg) =>
              `${pkg.name}: publish placeholder@${PLACEHOLDER_DIST_TAG}, then npm trust ${options.provider} ${PROJECT_FLAG[options.provider]} ${repo} --file ${options.workflow}`,
          )
          .join("\n"),
        dryRun ? "Dry run" : "Configure trusted publishing",
      );

      const s = spinner();
      const lines: string[] = [];

      for (const pkg of targets) {
        if (dryRun) {
          lines.push(
            `would configure ${pkg.name} (placeholder ${PLACEHOLDER_VERSION}@${PLACEHOLDER_DIST_TAG})`,
          );
          continue;
        }

        s.start(`${pkg.name}: publishing placeholder`);
        try {
          await publishPlaceholder(pkg);
          s.message(`${pkg.name}: configuring trusted publishing`);
          await npmTrust(context, pkg, options, repo);
          s.stop(`${pkg.name}: configured`);
          lines.push(
            `configured ${pkg.name} (placeholder ${PLACEHOLDER_VERSION}@${PLACEHOLDER_DIST_TAG})`,
          );
        } catch (error) {
          s.stop(`${pkg.name}: failed`);
          throw error;
        }
      }

      note(lines.join("\n"), "Result");
      outro(
        dryRun
          ? "Dry run complete. Re-run without --dry-run to publish placeholders and configure trusted publishing."
          : "Trusted publishing configured. CI can now publish real package versions with OIDC.",
      );
    });
}

async function resolvePretrustTargets(context: TegamiContext): Promise<NpmPackage[]> {
  const plan = await initPublishPlan(context, {});
  if (!plan) {
    throw new Error(
      `No publish lock found at ${context.lockPath}. Run "tegami version" before configuring trusted publishing.`,
    );
  }

  await runPreflights(context, plan);

  return (
    await Promise.all(
      Array.from(plan.packages, async ([id, { preflight }]) => {
        if (!preflight?.shouldPublish) return;
        const pkg = context.graph.get(id);
        if (!pkg || !(pkg instanceof NpmPackage)) return;
        if (await isPackageOnRegistry(pkg.name, pkg.getRegistry())) return;
        return pkg;
      }),
    )
  ).filter((pkg): pkg is NpmPackage => pkg !== undefined);
}

async function isPackageOnRegistry(
  name: string,
  registry = "https://registry.npmjs.org",
): Promise<boolean> {
  const response = await fetch(joinPath(registry, name), {
    headers: { Accept: "application/json" },
  });

  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(
      `Unable to check whether ${name} exists on the npm registry${registry ? ` "${registry}"` : ""}.`,
    );
  }

  return true;
}

async function publishPlaceholder(pkg: NpmPackage): Promise<void> {
  const registry = pkg.getRegistry();
  const access = pkg.manifest.publishConfig?.access;

  const dir = await mkdtemp(join(tmpdir(), "tegami-npm-placeholder-"));
  try {
    await writeFile(
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
    );
    await writeFile(
      join(dir, "README.md"),
      `# Placeholder package

This empty package was published by [Tegami](https://tegami.fuma-nama.dev) to configure npm trusted publishing.

The real package contents will be published via CI with OIDC.
`,
    );

    const args = ["publish", "--tag", PLACEHOLDER_DIST_TAG, "--ignore-scripts"];
    if (access) args.push("--access", access);
    if (registry) args.push("--registry", registry);

    const result = await x("npm", args, { nodeOptions: { cwd: dir } });
    if (result.exitCode !== 0) {
      throw execFailure(
        `Failed to publish placeholder ${pkg.name}@${PLACEHOLDER_VERSION} with dist-tag "${PLACEHOLDER_DIST_TAG}".`,
        result,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
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

  const result = await x("npm", args, { nodeOptions: { cwd: context.cwd } });
  if (result.exitCode !== 0) {
    throw execFailure(`Failed to configure trusted publishing for ${pkg.name}.`, result);
  }
}
