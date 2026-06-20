import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  autocompleteMultiselect,
  confirm,
  intro,
  isCancel,
  multiline,
  note,
  outro,
  select,
  spinner,
} from "@clack/prompts";
import { Command } from "commander";
import type { Awaitable } from "../types";
import { bumpDepth, type BumpType } from "../utils/semver";
import { changelogFilename } from "../utils/changelog";
import { isCI } from "../utils/constants";
import { handlePluginError } from "../utils/error";
import { assertPublishPlanFinished } from "../plans/checks";
import { dump } from "js-yaml";
import type { Tegami } from "..";
import type { PackageGroup, WorkspacePackage } from "../graph";
import type { DraftPlan } from "../plans/draft";
import type { PublishResult } from "../publish";
import { initAgent } from "./init-agent";
import { runCiPr } from "./ci-pr";
import { getChangedPackages } from "../utils/git-changes";

export interface TegamiCLIOptions {
  /** create a custom draft plan, it must not be applied */
  version?: () => Awaitable<DraftPlan>;
  publish?: () => Awaitable<PublishResult>;
}

interface ChangelogCommandOptions {}

interface VersionCommandOptions {}

interface PublishCommandOptions {
  dryRun?: boolean;
}

interface InitAgentCommandOptions {
  output?: string;
}

interface CiPrCommandOptions {
  repo?: string;
  pr?: number;
  branch?: string;
  print?: boolean;
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
      runAction(tegami, async () => {
        await versionPackages(tegami, { ...commandOptions, cli: options });
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

  // TODO: is there better way for this to avoid running any code?
  // this will run tegami script on every PR, which can compromise the runner
  program
    .command("ci-pr")
    .description("comment on a pull request with release preview and changelog guidance")
    .option("--repo <repo>", "GitHub repository (owner/name)")
    .option("--pr <number>", "pull request number", (value) => Number(value))
    .option("--branch <branch>", "PR head branch for the create-changelog link")
    .option("--print", "print the comment body without posting")
    .action((commandOptions: CiPrCommandOptions) =>
      runAction(tegami, () => runCiPrCommand(tegami, commandOptions)),
    );

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

async function createChangelogs(
  tegami: Tegami,
  _options: ChangelogCommandOptions & { cli: TegamiCLIOptions },
): Promise<void> {
  const context = await tegami._internal.context();
  await assertPublishPlanFinished(context);

  intro("Create changelogs");
  let selectedPackages: string[] = [];

  if (!isCI()) {
    const useShortname = new Map<string, boolean>();

    for (const pkg of context.graph.getPackages()) {
      if (useShortname.has(pkg.name)) useShortname.set(pkg.name, false);
      else useShortname.set(pkg.name, true);
    }

    const getPackageLabel = (pkg: WorkspacePackage) => {
      return useShortname.get(pkg.name) ? pkg.name : pkg.id;
    };

    const changedPackages = new Set(await getChangedPackages(context.graph, context.cwd));
    const selectOptions: {
      label: string;
      value: string;
      hint?: string;
    }[] = [];
    const groups: [PackageGroup, changed: boolean][] = [];
    for (const group of context.graph.getGroups()) {
      const changed = group.packages.some((pkg) => changedPackages.has(pkg));
      groups.push([group, changed]);
    }
    groups.sort((a, b) => (a[1] ? 0 : 1) - (b[1] ? 0 : 1));
    for (const [group, changed] of groups) {
      const members = group.packages.map(getPackageLabel).join(", ");
      selectOptions.push({
        label: `Group ${group.name}`,
        value: `group:${group.name}`,
        hint: changed ? `changed · ${members}` : members,
      });
    }

    const packages = context.graph
      .getPackages()
      .toSorted((a, b) => (changedPackages.has(a) ? 0 : 1) - (changedPackages.has(b) ? 0 : 1));
    for (const pkg of packages) {
      selectOptions.push({
        label: getPackageLabel(pkg),
        value: pkg.id,
        hint: changedPackages.has(pkg) ? "changed" : undefined,
      });
    }

    const selected = await autocompleteMultiselect({
      message: "Select packages (leave empty to auto-generate from commits)",
      required: false,
      options: selectOptions,
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

  const message = await multiline({
    message: "Describe change (Markdown supported, press tab then enter to exit)",
    placeholder: "The first line is heading\n\nAdditional description.",
    showSubmit: true,
    validate(value) {
      if (!value?.trim()) return "Enter a message.";
    },
  });
  if (isCancel(message)) throw new CancelledError();

  const filename = changelogFilename();

  const s = spinner();
  s.start("Creating changelog");
  await mkdir(context.changelogDir, { recursive: true });
  await writeFile(
    join(context.changelogDir, filename),
    renderManualChangelog(selectedPackages, type, message.trim()),
  );
  s.stop("Created changelog file");

  note(`${filename}\n${selectedPackages.join(", ")}: ${type}`, "Created changelog");
  outro("Changelog ready.");
}

async function versionPackages(
  tegami: Tegami,
  options: VersionCommandOptions & { cli: TegamiCLIOptions },
): Promise<boolean> {
  intro("Version Packages");

  const { version: customVersion } = options.cli;
  const context = await tegami._internal.context();
  const draft = customVersion ? await customVersion() : await tegami.draft();
  if (!draft.canApply()) {
    throw new Error(`The draft plan from custom "version" hook must not be applied`);
  }

  for (const plugin of context.plugins) {
    await handlePluginError(plugin, "cli.publishPlanCreated", () =>
      plugin.cli?.publishPlanCreated?.call(context, draft),
    );
  }

  if (!draft.hasPending()) {
    note("No pending changelog entries matched workspace packages.", "Nothing to version");
    outro("No versions changed.");
    return false;
  }

  const planEntries: string[] = [];
  for (const pkg of context.graph.getPackages()) {
    const plan = draft.getPackagePlan(pkg.id);
    if (!plan?.type) continue;

    planEntries.push(`${pkg.id}: ${plan.type} (${plan.changelogs?.length ?? 0} changelogs)`);
    if (plan.bumpReasons)
      for (const reason of plan.bumpReasons) {
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
  return true;
}

async function publishPackages(
  tegami: Tegami,
  options: PublishCommandOptions & {
    cli: TegamiCLIOptions;
  },
): Promise<boolean> {
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
    return false;
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
    return false;
  }

  outro(dryRun ? "Publish plan is valid." : "Packages published.");
  return true;
}

async function runCiPrCommand(tegami: Tegami, options: CiPrCommandOptions): Promise<void> {
  const context = await tegami._internal.context();
  const draft = await tegami.draft();
  const result = await runCiPr(context, draft, options);

  if (result.posted) {
    outro(
      result.action === "updated"
        ? "Updated pull request comment."
        : "Created pull request comment.",
    );
    return;
  }

  note(result.body, "Pull request comment");
  outro(options.print ? "Comment preview ready." : "Pull request comment ready.");
}

async function runInitAgent(tegami: Tegami, options: InitAgentCommandOptions): Promise<void> {
  intro("Init agent instructions");

  const context = await tegami._internal.context();
  const s = spinner();
  s.start("Writing AGENTS.md");
  const result = await initAgent(context, options);
  s.stop(result.created ? "Created AGENTS.md" : "Appended to AGENTS.md");

  note(relative(context.cwd, result.path) || "AGENTS.md", "Agent instructions");
  outro("Agents can follow AGENTS.md to write changelogs.");
}

async function runCleanup(tegami: Tegami): Promise<void> {
  intro("Cleanup publish plan");

  const s = spinner();
  s.start("Checking publish plan status");
  const result = await tegami.cleanup();
  const { planPath } = await tegami._internal.context();
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

function renderManualChangelog(packages: string[], type: BumpType, message: string): string {
  const prefix = "#".repeat(bumpDepth(type));
  const packageMap: Record<string, BumpType> = {};

  for (const name of packages) {
    packageMap[name] = type;
  }

  return [
    "---",
    dump({
      packages: packageMap,
    }).trim(),
    "---",
    "",
    `${prefix} ${message}`,
    "",
  ].join("\n");
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
