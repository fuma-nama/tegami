import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  confirm,
  intro,
  isCancel,
  multiselect,
  note,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";
import { Command } from "commander";
import type { DraftPlan, PublishResult, Tegami } from "..";
import type { Awaitable } from "../types";
import type { BumpType } from "../utils/semver";
import { isCI } from "../utils/constants";
import { handlePluginError } from "../utils/error";

export interface TegamiCLIOptions {
  /** create a custom draft plan, it must be editable */
  version?: () => Awaitable<DraftPlan>;
  publish?: () => Awaitable<PublishResult>;
}

interface ChangelogCommandOptions {}

interface VersionCommandOptions {}

interface PublishCommandOptions {
  dryRun?: boolean;
}

class CancelledError extends Error {
  constructor() {
    super("Cancelled.");
  }
}

export function createCli(tegami: Tegami, options: TegamiCLIOptions = {}) {
  const program = new Command();

  program
    .name("tegami")
    .description("create changelogs")
    .action((commandOptions: ChangelogCommandOptions) =>
      runAction(tegami, () => createChangelogs(tegami, { ...commandOptions, cli: options })),
    );

  program
    .command("version")
    .description("draft and apply a publish plan")
    .action((commandOptions: VersionCommandOptions) =>
      runAction(tegami, () => versionPackages(tegami, { ...commandOptions, cli: options })),
    );

  program
    .command("publish")
    .description("publish packages from the applied publish plan")
    .option("--dry-run", "validate the publish plan without publishing packages")
    .action((commandOptions: PublishCommandOptions) =>
      runAction(tegami, () => publishPackages(tegami, { ...commandOptions, cli: options })),
    );

  program
    .command("cleanup")
    .description("remove the publish plan after all packages have been published")
    .action(() => runAction(tegami, () => runCleanup(tegami)));

  return program;
}

async function createChangelogs(
  tegami: Tegami,
  _options: ChangelogCommandOptions & { cli: TegamiCLIOptions },
): Promise<void> {
  intro("Create changelogs");
  const { graph, cwd, changelogDir } = await tegami._internal.context();
  const packages = graph.getPackages();
  let selectedPackages: string[] = [];

  if (isCI()) {
    selectedPackages = [];
  } else {
    const selected = await multiselect({
      message: "Select packages (leave empty to auto-generate from commits)",
      required: false,
      options: packages.map((pkg) => ({
        value: pkg.id,
        label: pkg.id,
        hint: pkg.version,
      })),
    });

    if (isCancel(selected)) throw new CancelledError();
    selectedPackages = selected;
  }

  if (selectedPackages.length === 0) {
    if (!isCI()) {
      const confirmed = await confirm({
        message: "Auto-generate changelog files from commits?",
        initialValue: true,
      });
      if (isCancel(confirmed)) throw new CancelledError();

      if (!confirmed) {
        outro("No changelogs created.");
        return;
      }
    }

    const s = spinner();
    s.start("Reading commits and creating changelogs");
    const created = await tegami.generateChangelog();
    s.stop(
      created.length === 1
        ? "Created 1 changelog file"
        : `Created ${created.length} changelog files`,
    );

    if (created.length === 0) {
      note("No matching conventional commits were found.", "No changelogs created");
    } else {
      note(
        created.map((entry) => `${entry.filename} (${entry.changes} changes)`).join("\n"),
        "Created changelogs",
      );
    }

    outro("Changelogs ready.");
    return;
  }

  const type = await select({
    message: "Select release type",
    options: [
      { value: "patch", label: "patch" },
      { value: "minor", label: "minor" },
      { value: "major", label: "major" },
    ],
  });
  if (isCancel(type)) throw new CancelledError();

  const message = await text({
    message: "Change message",
    placeholder: "Add a concise release note",
    validate(value) {
      if (!value?.trim()) return "Enter a message.";
    },
  });
  if (isCancel(message)) throw new CancelledError();

  const filename = changelogFilename();
  const directory = resolve(cwd, changelogDir);

  const s = spinner();
  s.start("Creating changelog");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, filename),
    renderManualChangelog(selectedPackages, type, message.trim()),
  );
  s.stop("Created changelog file");

  note(`${filename}\n${selectedPackages.join(", ")}: ${type}`, "Created changelog");
  outro("Changelog ready.");
}

async function versionPackages(
  tegami: Tegami,
  options: VersionCommandOptions & { cli: TegamiCLIOptions },
): Promise<void> {
  intro("Version Packages");

  const { version: customVersion } = options.cli;
  const context = await tegami._internal.context();
  const draft = customVersion ? await customVersion() : await tegami.draft();
  if (!draft.editable()) {
    throw new Error(`The custom "version" hook must return an editable draft plan`);
  }

  for (const plugin of context.plugins) {
    await handlePluginError(plugin, "cli.publishPlanCreated", () =>
      plugin.cli?.publishPlanCreated?.call(context, draft),
    );
  }

  if (draft.hasPending()) {
    note("No pending changelog entries matched workspace packages.", "Nothing to version");
    outro("No versions changed.");
    return;
  }

  const planEntries: string[] = [];
  for (const pkg of context.graph.getPackages()) {
    const plan = draft.getPackagePlan(pkg.id);
    if (!plan?.type) continue;

    planEntries.push(`${pkg.id}: ${plan.type} (${plan.changelogs?.length ?? 0} changelogs)`);
    for (const reason of plan.bumpReasons ?? []) {
      planEntries.push(`  - ${reason}`);
    }
  }

  note(planEntries.join("\n"), "Release plan");

  const s = spinner();
  s.start("Updating package versions");

  try {
    await draft.applyPlan();
  } catch (error) {
    s.stop("Failed to apply publish plan");
    throw error;
  }

  s.stop("Package versions updated");

  for (const plugin of context.plugins) {
    await handlePluginError(plugin, "cli.publishPlanApplied", () =>
      plugin.cli?.publishPlanApplied?.call(context, draft),
    );
  }

  outro("Publish plan applied.");
}

async function publishPackages(
  tegami: Tegami,
  options: PublishCommandOptions & {
    cli: TegamiCLIOptions;
  },
): Promise<void> {
  const dryRun = options.dryRun ?? false;
  const { publish: customPublish } = options.cli;
  intro(dryRun ? "Publish packages (dry run)" : "Publish packages");

  const s = spinner();
  s.start(dryRun ? "Validating publish plan" : "Publishing packages");
  const result = customPublish ? await customPublish() : await tegami.publish({ dryRun });

  if (result.state === "skipped") {
    const { planPath } = await tegami._internal.context();
    s.stop(dryRun ? "No publish plan to validate" : "Nothing to publish");
    outro(`No publishable packages were found in ${planPath}.`);
    return;
  }

  s.stop(dryRun ? "Publish plan validated" : "Publish complete");
  note(
    result.packages
      .map((pkg) => {
        const tag = pkg.npm?.distTag ? ` (${pkg.npm.distTag})` : "";
        const suffix = pkg.state === "failed" && pkg.error ? `: ${pkg.error}` : "";
        return `${pkg.state === "success" ? "success" : "failed"} ${pkg.name}@${pkg.version}${tag}${suffix}`;
      })
      .join("\n"),
    dryRun ? "Publish dry run" : "Publish result",
  );

  if (result.state === "failed") {
    process.exitCode = 1;
    outro("Some packages failed to publish.");
    return;
  }

  outro(dryRun ? "Publish plan is valid." : "Packages published.");
}

async function runCleanup(tegami: Tegami): Promise<void> {
  intro("Cleanup publish plan");

  const s = spinner();
  s.start("Checking publish plan status");
  const result = await tegami.cleanup();
  s.stop(result.state === "removed" ? "Publish plan removed" : "Publish plan kept");

  if (result.state === "removed") {
    outro(`Removed ${result.planPath}.`);
    return;
  }

  if (result.reason === "missing") {
    outro(`No publish plan found at ${result.planPath}.`);
    return;
  }

  outro(`Publish plan at ${result.planPath} is still pending. Publish it before cleanup.`);
}

function renderManualChangelog(packages: string[], type: BumpType, message: string): string {
  const heading = "#".repeat(type === "major" ? 1 : type === "minor" ? 2 : 3);

  return [
    "---",
    `packages: ${JSON.stringify(packages)}`,
    "---",
    "",
    `${heading} ${message}`,
    "",
  ].join("\n");
}

function changelogFilename(): string {
  const date = new Date();
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hash = Date.now().toString(36);

  return `${yyyy}-${mm}-${dd}-${hash}.md`;
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
