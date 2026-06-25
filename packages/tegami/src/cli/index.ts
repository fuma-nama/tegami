import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { intro, note, outro, spinner } from "@clack/prompts";
import { Command, InvalidArgumentError } from "commander";
import type { Awaitable } from "../types";
import { isCI } from "../utils/constants";
import { CancelledError, handlePluginError } from "../utils/error";
import type { PublishPlan, Tegami } from "..";
import type { Draft } from "../plans/draft";
import { runChangelogTui } from "./changelog";
import { initAgent } from "./init-agent";
import { buildPrPreview, postPrComment } from "./pr";

export interface TegamiCLIOptions {
  /** create a custom draft, it must not be applied */
  version?: () => Awaitable<Draft>;
  publish?: () => Awaitable<PublishPlan>;
}

interface PublishCommandOptions {
  dryRun?: boolean;
}

interface InitAgentCommandOptions {
  output?: string;
}

interface PrPreviewCommandOptions {
  artifact?: string;
  number?: number;
}

export function createCli(tegami: Tegami, options: TegamiCLIOptions = {}) {
  const program = new Command();

  program
    .name("tegami")
    .description("create changelogs")
    .action(() => runAction(tegami, () => runChangelogTui(tegami)));

  program
    .command("version")
    .description("draft and apply a publish plan")
    .action(() =>
      runAction(tegami, async () => {
        await versionPackages(tegami, { cli: options });
      }),
    );

  program
    .command("ci")
    .description("version and publish packages")
    .action(() =>
      runAction(tegami, async () => {
        const versioned = await versionPackages(tegami, { cli: options });
        if (versioned) return;
        await publishPackages(tegami, { cli: options });
      }),
    );

  const programPr = program.command("pr");

  programPr
    .command("preview")
    .description(
      "(should be executed in a GitHub action) show a pull request release preview and changelog guidance",
    )
    .option("--artifact <path>", "write preview markdown to a file")
    .option("--number <number>", "pull request number", (value) => {
      const number = Number(value);
      if (!Number.isInteger(number) || number <= 0) {
        throw new InvalidArgumentError("--number must be a positive integer.");
      }
      return number;
    })
    .action((commandOptions: PrPreviewCommandOptions) =>
      runAction(tegami, async () => {
        const context = await tegami._internal.context();
        const body = await buildPrPreview(context, await tegami.draft(), commandOptions);

        if (commandOptions.artifact) {
          const artifactPath = path.resolve(context.cwd, commandOptions.artifact);
          await writeFile(artifactPath, body);
          if (!isCI()) {
            note(
              path.relative(context.cwd, artifactPath) || commandOptions.artifact,
              "Release preview",
            );
            outro("Release preview ready.");
          }
          return;
        }

        if (isCI()) {
          process.stdout.write(`${body}\n`);
          return;
        }

        note(body, "Release preview");
        outro("Release preview ready.");
      }),
    );

  programPr
    .command("comment")
    .description(
      "(should be used with 'pr preview') post the pull request release preview as a comment",
    )
    .argument("<artifact>", "the file path of GitHub artifact")
    .action(async (artifact: string) => {
      try {
        await postPrComment(await readFile(artifact, "utf8"));
        outro("Pull request comment updated.");
      } catch (error) {
        note(error instanceof Error ? error.message : String(error), "Error");
        outro("Command failed.");
        process.exit(1);
      }
    });

  program
    .command("publish")
    .description("publish packages from the applied publish plan")
    .option("--dry-run", "validate the publish plan without publishing packages")
    .action((commandOptions: PublishCommandOptions) =>
      runAction(tegami, async () => {
        await publishPackages(tegami, { ...commandOptions, cli: options });
      }),
    );

  program
    .command("cleanup")
    .description("remove the publish plan after all packages have been published")
    .action(() => runAction(tegami, () => runCleanup(tegami)));

  program
    .command("init-agent")
    .description("write AGENTS.md with changelog instructions for AI agents")
    .option("-o, --output <path>", "output path", "AGENTS.md")
    .action((commandOptions: InitAgentCommandOptions) =>
      runAction(tegami, () => runInitAgent(tegami, commandOptions)),
    );

  return program;
}

async function versionPackages(
  tegami: Tegami,
  options: { cli: TegamiCLIOptions },
): Promise<boolean> {
  intro("Version Packages");

  const { version: customVersion } = options.cli;
  const context = await tegami._internal.context();
  const draft = customVersion ? await customVersion() : await tegami.draft();
  if (!draft.canApply()) {
    throw new Error(`The draft from custom "version" hook must not be applied`);
  }

  for (const plugin of context.plugins) {
    await handlePluginError(plugin, "cli.draftCreated", () =>
      plugin.cli?.draftCreated?.call(context, draft),
    );
  }

  if (!draft.hasPending()) {
    note("No pending version changes matched workspace packages.", "Nothing to version");
    outro("No versions changed.");
    return false;
  }

  const planEntries: string[] = [];
  for (const pkg of context.graph.getPackages()) {
    const plan = draft.getPackageDraft(pkg.id);
    if (!plan || plan.bumpVersion(pkg) === pkg.version) continue;

    planEntries.push(
      `${pkg.id}: ${pkg.version} → ${plan.bumpVersion(pkg)} (${plan.changelogs?.length ?? 0} changelogs)`,
    );
    if (plan.bumpReasons)
      for (const reason of plan.bumpReasons) {
        planEntries.push(`  - ${reason}`);
      }
  }

  note(planEntries.join("\n"), "Release plan");

  const s = spinner();
  s.start("Updating package versions");

  try {
    await draft.apply();
  } catch (error) {
    s.stop("Failed to apply publish plan");
    throw error;
  }

  s.stop("Package versions updated");

  for (const plugin of context.plugins) {
    await handlePluginError(plugin, "cli.draftApplied", () =>
      plugin.cli?.draftApplied?.call(context, draft),
    );
  }

  outro("Publish plan applied.");
  return true;
}

async function publishPackages(
  tegami: Tegami,
  options: PublishCommandOptions & {
    cli: TegamiCLIOptions;
  },
): Promise<boolean> {
  const dryRun = options.dryRun ?? false;
  const context = await tegami._internal.context();
  const { publish: customPublish } = options.cli;
  intro(dryRun ? "Publish packages (dry run)" : "Publish packages");

  const s = spinner();
  s.start(dryRun ? "Validating publish plan" : "Publishing packages");
  const plan = customPublish ? await customPublish() : await tegami.publish({ dryRun });

  if (plan === "skipped") {
    s.stop(dryRun ? "No publish plan to validate" : "Nothing to publish");
    outro(`No publishable packages were found in ${context.lockPath}.`);
    return false;
  }

  s.stop(dryRun ? "Publish plan validated" : "Publish complete");
  const lines: string[] = [];
  let hasFailed = false;

  for (const [id, packagePlan] of plan.packages) {
    const result = packagePlan.publishResult!;
    const pkg = context.graph.get(id);
    if (!pkg) continue;

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

  outro(dryRun ? "Publish plan is valid." : "Packages published.");
  return true;
}

async function runInitAgent(tegami: Tegami, options: InitAgentCommandOptions): Promise<void> {
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
  intro("Cleanup publish plan");

  const s = spinner();
  s.start("Checking publish plan status");
  const result = await tegami.cleanup();
  const { lockPath: planPath } = await tegami._internal.context();
  s.stop(result.state === "removed" ? "Publish plan removed" : "Publish plan kept");

  if (result.state === "removed") {
    outro(`Removed ${planPath}.`);
    return;
  }

  if (result.reason === "missing") {
    outro(`No publish plan found at ${planPath}.`);
    return;
  }

  outro(`Publish plan at ${planPath} is still pending. Publish it before cleanup.`);
}

async function runAction(tegami: Tegami, action: () => Awaitable<void>): Promise<void> {
  try {
    const context = await tegami._internal.context();

    for (const plugin of context.plugins) {
      await handlePluginError(plugin, "cli.init", () => plugin.cli?.init?.call(context));
    }

    await action();
  } catch (error) {
    if (error instanceof CancelledError) {
      outro(error.message);
    } else {
      note(error instanceof Error ? error.message : String(error), "Error");
      outro("Command failed.");
    }

    process.exit(1);
  }
}
