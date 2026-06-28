import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { intro, note, outro, spinner } from "@clack/prompts";
import type { Awaitable } from "../types";
import { isCI } from "../utils/common";
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

export interface TegamiCLI {
  parseAsync(argv?: string[]): Promise<void>;
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

export function createCli(tegami: Tegami, options: TegamiCLIOptions = {}): TegamiCLI {
  return {
    async parseAsync(argv) {
      await runCliProgram(tegami, options, argv);
    },
  };
}

export async function runCli(tegami: Tegami, options: TegamiCLIOptions = {}): Promise<void> {
  await runCliProgram(tegami, options);
}

async function runCliProgram(
  tegami: Tegami,
  options: TegamiCLIOptions,
  argv = process.argv.slice(2),
) {
  try {
    if (argv.length === 0) {
      await runAction(tegami, () => runChangelogTui(tegami));
      return;
    }

    const [command, ...rest] = argv;

    if (command === "--help" || command === "-h") {
      console.log(`Usage: tegami [command]

create changelogs

Commands:
  version         draft version changes and write the publish lock
  ci              version and publish packages
  check-publish   exit with code 1 if no publishing needed, otherwise 0
  pr preview      show a pull request release preview and changelog guidance
  pr comment      post the pull request release preview as a comment
  publish         publish packages from the publish lock
  cleanup         remove the publish lock after all packages have been published
  init-agent      write AGENTS.md with changelog instructions for AI agents

Run without a command to open the changelog TUI.
`);
      return;
    }

    switch (command) {
      case "version": {
        if (rest.length > 0) {
          if (rest[0] === "--help" || rest[0] === "-h") {
            console.log(`Usage: tegami version`);
            process.exit(0);
          }
          throw new Error(`Unknown option: ${rest[0]}`);
        }
        await runAction(tegami, async () => {
          await versionPackages(tegami, { cli: options });
        });
        break;
      }
      case "ci": {
        if (rest.length > 0) {
          if (rest[0] === "--help" || rest[0] === "-h") {
            console.log(`Usage: tegami ci`);
            process.exit(0);
          }
          throw new Error(`Unknown option: ${rest[0]}`);
        }
        await runAction(tegami, async () => {
          const versioned = await versionPackages(tegami, { cli: options });
          if (versioned) return;
          await publishPackages(tegami, { cli: options });
        });
        break;
      }
      case "check-publish": {
        if (rest.length > 0) {
          if (rest[0] === "--help" || rest[0] === "-h") {
            console.log(`Usage: tegami check-publish`);
            process.exit(0);
          }
          throw new Error(`Unknown option: ${rest[0]}`);
        }
        await runAction(tegami, async () => {
          const status = await tegami.publishStatus();
          process.exit(status === "pending" ? 0 : 1);
        });
        break;
      }
      case "pr": {
        const [subcommand, ...prRest] = rest;

        switch (subcommand) {
          case "preview":
            await runPrPreviewCommand(tegami, prRest);
            break;
          case "comment":
            await runPrCommentCommand(prRest);
            break;
          case "--help":
          case "-h":
          case undefined:
            console.log(`Usage: tegami pr <command>

Commands:
  preview  show a pull request release preview and changelog guidance
  comment  post the pull request release preview as a comment
`);
            break;
          default:
            throw new Error(`Unknown pr command: ${subcommand}`);
        }
        break;
      }
      case "publish":
        await runPublishCommand(tegami, options, rest);
        break;
      case "cleanup": {
        if (rest.length > 0) {
          if (rest[0] === "--help" || rest[0] === "-h") {
            console.log(`Usage: tegami cleanup`);
            process.exit(0);
          }
          throw new Error(`Unknown option: ${rest[0]}`);
        }
        await runAction(tegami, () => runCleanup(tegami));
        break;
      }
      case "init-agent":
        await runInitAgentCommand(tegami, rest);
        break;
      default:
        throw new Error(`Unknown command: ${command}`);
    }
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

async function runPublishCommand(tegami: Tegami, options: TegamiCLIOptions, args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`Usage: tegami publish [--dry-run]

publish packages from the publish lock
`);
    return;
  }

  await runAction(tegami, async () => {
    await publishPackages(tegami, { dryRun: values["dry-run"], cli: options });
  });
}

async function runInitAgentCommand(tegami: Tegami, args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      output: { type: "string", short: "o", default: "AGENTS.md" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`Usage: tegami init-agent [-o, --output <path>]

write AGENTS.md with changelog instructions for AI agents
`);
    return;
  }

  await runAction(tegami, () => runInitAgent(tegami, { output: values.output }));
}

async function runPrPreviewCommand(tegami: Tegami, args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      artifact: { type: "string" },
      number: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`Usage: tegami pr preview [--artifact <path>] [--number <number>]

show a pull request release preview and changelog guidance
`);
    return;
  }

  const commandOptions: PrPreviewCommandOptions = {
    artifact: values.artifact,
    number: values.number ? parsePositiveInt(values.number, "--number") : undefined,
  };

  await runAction(tegami, async () => {
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
  });
}

async function runPrCommentCommand(args: string[]) {
  const { positionals, values } = parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`Usage: tegami pr comment <artifact>

post the pull request release preview as a comment
`);
    return;
  }

  const artifact = positionals[0];
  if (!artifact) throw new Error("missing required argument: artifact");

  await postPrComment(await readFile(artifact, "utf8"));
  outro("Pull request comment updated.");
}

function parsePositiveInt(value: string, option: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${option} must be a positive integer.`);
  }
  return number;
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

  if ((await tegami.publishStatus()) === "pending") {
    note(
      `Publish lock at ${context.lockPath} is still pending. Publish it before applying a new draft.`,
    );
    outro("Cannot apply.");
    return false;
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
    await handlePluginError(plugin, "cli.draftApplied", () =>
      plugin.cli?.draftApplied?.call(context, draft),
    );
  }

  outro("Publish lock written.");
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
  s.start(dryRun ? "Validating publish lock" : "Publishing packages");
  const plan = customPublish ? await customPublish() : await tegami.publish({ dryRun });

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

async function runAction(tegami: Tegami, action: () => Awaitable<void>): Promise<void> {
  const context = await tegami._internal.context();

  for (const plugin of context.plugins) {
    await handlePluginError(plugin, "cli.init", () => plugin.cli?.init?.call(context));
  }

  await action();
}
