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

export interface TegamiCLIOptions {
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
    .description("Create changelogs, version packages, and publish releases.")
    .action((commandOptions: ChangelogCommandOptions) =>
      runAction(() => createChangelogs(tegami, { ...commandOptions, cli: options })),
    );

  program
    .command("version")
    .description("create a publish plan and update package versions")
    .action((commandOptions: VersionCommandOptions) =>
      runAction(() => versionPackages(tegami, { ...commandOptions, cli: options })),
    );

  program
    .command("publish")
    .description("publish packages from the current publish plan")
    .option("--dry-run", "validate the publish plan without publishing packages")
    .action((commandOptions: PublishCommandOptions) =>
      runAction(() => publishPackages(tegami, { ...commandOptions, cli: options })),
    );

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
  const draft = customVersion ? await customVersion() : await tegami.draft();
  const packageIds = draft.getPackageIds();

  if (packageIds.length === 0) {
    note("No pending changelog entries matched workspace packages.", "Nothing to version");
    outro("No versions changed.");
    return;
  }

  note(
    packageIds
      .map((id) => {
        const plan = draft.getPackage(id)!;
        return `${id}: ${plan.type} (${plan.changelogIds.size} changelogs)`;
      })
      .join("\n"),
    "Release plan",
  );

  if (draft.editable()) {
    const s = spinner();
    s.start("Updating package versions");

    try {
      await draft.createPublishPlan();
    } catch (error) {
      s.stop("Failed to create publish plan");
      throw error;
    }

    s.stop("Package versions updated");
  }

  const context = await tegami._internal.context();
  for (const plugin of context.plugins) {
    await plugin.cli?.afterVersion?.call(context, draft);
  }

  outro("Publish plan created.");
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
    s.stop(dryRun ? "No publish plan to validate" : "Nothing to publish");
    outro(`No publishable packages were found in ${result.planPath}.`);
    return;
  }

  s.stop(dryRun ? "Publish plan validated" : "Publish complete");
  note(
    result.packages
      .map((pkg) => {
        const tag = pkg.distTag ? ` (${pkg.distTag})` : "";
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

async function runAction(action: () => Awaitable<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    process.exitCode = 1;

    if (error instanceof CancelledError) {
      outro(error.message);
      return;
    }

    note(error instanceof Error ? error.message : String(error), "Error");
    outro("Command failed.");
  }
}
