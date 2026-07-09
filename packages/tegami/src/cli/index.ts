import path from "node:path";
import { intro, note, outro, spinner } from "@clack/prompts";
import type { Awaitable } from "../types";
import { CancelledError, handlePluginError } from "../utils/error";
import type { PublishPlan, Tegami } from "..";
import type { Draft } from "../plans/draft";
import { runChangelogTui } from "./changelog";
import { initAgent } from "./init-agent";
import { createTegamiCliRegistry, type TegamiCliRegistry } from "./core";

export interface TegamiCLIOptions {
  /** create a custom draft, it must not be applied */
  version?: () => Awaitable<Draft>;
  publish?: () => Awaitable<PublishPlan>;
}

export interface TegamiCLI {
  parseAsync(argv?: string[]): Promise<void>;
}

export function createCli(tegami: Tegami, options: TegamiCLIOptions = {}): TegamiCLI {
  const $cli = init();
  async function init() {
    const ctx = await tegami._internal.contextUnresolved();
    const cli = createTegamiCliRegistry(tegami);

    registerCoreCommands(cli, tegami, options);
    for (const plugin of ctx.plugins) {
      await handlePluginError(plugin, "initCli", () => plugin.initCli?.call(ctx, cli));
    }

    return cli;
  }

  return {
    async parseAsync(argv = process.argv.slice(2)) {
      try {
        const cli = await $cli;
        await cli.parse(argv);
      } catch (error) {
        if (error instanceof CancelledError) {
          outro(error.message);
        } else {
          note(error instanceof Error ? error.message : String(error), "Error");
          outro("Command failed.");
        }
        process.exit(1);
      }
    },
  };
}

export async function runCli(tegami: Tegami, options: TegamiCLIOptions = {}): Promise<void> {
  await createCli(tegami, options).parseAsync();
}

function registerCoreCommands(cli: TegamiCliRegistry, tegami: Tegami, options: TegamiCLIOptions) {
  cli.command("", { description: "create changelog files interactively" }).action(async () => {
    await runChangelogTui(tegami);
  });

  cli
    .command("version", { description: "draft version changes and write the publish lock" })
    .option("no-checks", {
      type: "boolean",
      description: "skip checking whether the publish lock is still pending",
    })
    .action(async ({ values }) => {
      await versionPackages(tegami, { cli: options, noChecks: values["no-checks"] });
    });

  cli.command("ci", { description: "version and publish packages" }).action(async () => {
    const versioned = await versionPackages(tegami, {
      cli: options,
      // should not check plan status, otherwise it will allow publish during draft phase
      noChecks: true,
    });
    if (versioned) return;
    await publishPackages(tegami, { cli: options });
  });

  cli
    .command("check-publish", {
      description: "exit with code 1 if no publishing needed, otherwise 0",
    })
    .action(async () => {
      const { status } = await tegami.getPublishStatus();
      process.exit(status === "pending" ? 0 : 1);
    });

  cli
    .command("publish", { description: "publish packages from the publish lock" })
    .option("dry-run", {
      type: "boolean",
      description: "validate the publish lock without publishing",
    })
    .positionals("packages")
    .action(async ({ values, positionals }) => {
      await publishPackages(tegami, {
        dryRun: values["dry-run"],
        packages: positionals.packages?.length ? positionals.packages : undefined,
        cli: options,
      });
    });

  cli
    .command("cleanup", {
      description: "remove the publish lock after all packages have been published",
    })
    .action(async () => {
      await runCleanup(tegami);
    });

  cli
    .command("init-agent", {
      description: "write AGENTS.md with changelog instructions for AI agents",
      resolve: false,
    })
    .option("output", {
      type: "string",
      short: "o",
      description: "output path",
    })
    .action(async ({ values }) => {
      await runInitAgent(tegami, { output: values.output ?? "AGENTS.md" });
    });
}

async function versionPackages(
  tegami: Tegami,
  options: { cli: TegamiCLIOptions; noChecks?: boolean },
): Promise<boolean> {
  intro("Version Packages");

  const { version: customVersion } = options.cli;
  const context = await tegami._internal.context();
  const draft = customVersion ? await customVersion() : await tegami.draft();
  if (!draft.canApply()) {
    throw new Error(`The draft from custom "version" hook must not be applied`);
  }

  for (const plugin of context.plugins) {
    await handlePluginError(plugin, "initCliDraft", () =>
      plugin.initCliDraft?.call(context, draft),
    );
  }

  if (!draft.hasPending()) {
    note("No pending version changes matched workspace packages.", "Nothing to version");
    outro("No versions changed.");
    return false;
  }

  if (!options.noChecks) {
    const { status, reason } = await tegami.getPublishStatus();
    if (status === "pending") {
      note(
        `Publish lock at ${context.lockPath} is still pending. Publish it before applying a new draft.`,
        "Failed to apply",
      );
      outro(reason ?? "Cannot apply.");
      return false;
    }
  }

  const lines: string[] = [];
  for (const pkg of context.graph.getPackages()) {
    const plan = draft.getPackageDraft(pkg.id);
    if (!plan) continue;
    const bumped = plan.bumpVersion(pkg);
    if (!pkg.version || !bumped || bumped === pkg.version) continue;

    lines.push(
      `${pkg.id}: ${pkg.version} → ${bumped} (${plan.changelogs?.length ?? 0} changelogs)`,
    );
    if (plan.bumpReasons)
      for (const reason of plan.bumpReasons) {
        lines.push(`  - ${reason}`);
      }
  }

  note(lines.join("\n"), "Release plan");

  const s = spinner();
  s.start("Updating package versions");

  try {
    await draft.apply();
  } catch (error) {
    s.stop("Failed to apply draft");
    throw error;
  }

  s.stop("Package versions updated");

  for (const plugin of context.plugins) {
    await handlePluginError(plugin, "applyCliDraft", () =>
      plugin.applyCliDraft?.call(context, draft),
    );
  }

  outro("Publish lock written.");
  return true;
}

async function publishPackages(
  tegami: Tegami,
  options: {
    cli: TegamiCLIOptions;
    dryRun?: boolean;
    packages?: string[];
  },
): Promise<boolean> {
  const dryRun = options.dryRun ?? false;
  const context = await tegami._internal.context();
  const { publish: customPublish } = options.cli;
  intro(dryRun ? "Publish packages (dry run)" : "Publish packages");

  const s = spinner();
  s.start(dryRun ? "Validating publish lock" : "Publishing packages");
  const plan = customPublish
    ? await customPublish()
    : await tegami.publish({
        dryRun,
        packages: options.packages && options.packages.length > 0 ? options.packages : undefined,
      });

  if (plan === "skipped") {
    s.stop(dryRun ? "No publish lock to validate" : "Nothing to publish");
    outro(`No publishable packages were found in ${context.lockPath}.`);
    return false;
  }

  s.stop(dryRun ? "Publish lock validated" : "Publish complete");
  const lines: string[] = [];
  let hasFailed = false;

  for (const [id, packagePlan] of plan.packages) {
    if (!packagePlan.preflight!.shouldPublish) continue;

    const result = packagePlan.publishResult!;
    const pkg = context.graph.get(id)!;

    if (result.type === "failed") {
      hasFailed = true;
    }

    let message = `${result.type} ${pkg.id} - ${pkg.version}`;

    const distTag = packagePlan.npm?.distTag;
    if (distTag) message += ` (npm dist-tag: ${distTag})`;
    if (result.type === "failed" && result.error) message += `: ${result.error}`;
    lines.push(message);
  }

  note(lines.join("\n"), dryRun ? "Publish dry run" : "Publish result");

  if (hasFailed) {
    process.exitCode = 1;
    outro("Failed to publish.");
    return false;
  }

  outro(dryRun ? "Publish lock is valid." : "Packages published.");
  return true;
}

async function runInitAgent(
  tegami: Tegami,
  options: {
    output?: string;
  },
): Promise<void> {
  intro("Init agent instructions");

  const context = await tegami._internal.context();
  const s = spinner();
  s.start("Writing AGENTS.md");
  const result = await initAgent(context, options);
  s.stop(result.created ? "Created AGENTS.md" : "Appended to AGENTS.md");

  note(path.relative(context.cwd, result.path) || "AGENTS.md", "Agent instructions");
  outro("Agents can follow AGENTS.md to write changelogs.");
}

async function runCleanup(tegami: Tegami): Promise<void> {
  intro("Cleanup publish lock");

  const s = spinner();
  s.start("Checking publish lock status");
  const result = await tegami.cleanup();
  const { lockPath } = await tegami._internal.context();
  s.stop(result.state === "removed" ? "Publish lock removed" : "Publish lock kept");

  if (result.state === "removed") {
    outro(`Removed ${lockPath}.`);
    return;
  }

  if (result.reason === "no-plan") {
    outro(`No publish lock found at ${lockPath}.`);
    return;
  }

  outro(`Publish lock at ${lockPath} is still pending. Publish it before cleanup.`);
}
