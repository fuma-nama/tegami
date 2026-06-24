import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
import type { Tegami } from "..";
import { changelogFilename, generateReplays } from "../changelog/generate";
import type { PackageGroup, PackageGraph, WorkspacePackage } from "../graph";
import type { TegamiContext } from "../context";
import { assertPublishPlanFinished } from "../plans/checks";
import { isCI } from "../utils/constants";
import { CancelledError } from "../utils/error";
import { getChangedPackages } from "../utils/git-changes";
import type { BumpType } from "../utils/semver";
import { type ChangelogPackageConfig, renderChangelog } from "../changelog/shared";

export async function runChangelogTui(tegami: Tegami): Promise<void> {
  const context = await tegami._internal.context();
  await assertPublishPlanFinished(context);

  intro("Create changelogs");
  let selectedPackages: string[] = [];

  if (!isCI()) {
    selectedPackages = await promptPackageSelection(context.graph, context.cwd);
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

    const created = await tegami.generateChangelog({ write: false });
    await persistChangelogs(
      context,
      created.map(({ filename, content, packages }) => ({ filename, content, packages })),
      "No matching conventional commits were found.",
    );
    return;
  }

  const packageBumpMap = await promptPackageBumpTypes(selectedPackages);
  const message = await multiline({
    message: "Describe change (Markdown supported, press tab then enter to exit)",
    placeholder: "The first line is heading\n\nAdditional description.",
    showSubmit: true,
    validate(value) {
      if (!value?.trim()) return "Enter a message.";
    },
  });
  if (isCancel(message)) throw new CancelledError();

  const packages = generateReplays(context.graph, packageBumpMap);
  const filename = changelogFilename();
  await persistChangelogs(context, [
    { filename, content: renderChangelog({ packages }, `## ${message.trim()}`), packages },
  ]);
}

async function persistChangelogs(
  context: TegamiContext,
  entries: {
    filename: string;
    content: string;
    packages: Record<string, BumpType | ChangelogPackageConfig>;
  }[],
  emptyMessage = "No changelogs created.",
): Promise<void> {
  const s = spinner();
  s.start("Creating changelog");
  await mkdir(context.changelogDir, { recursive: true });
  await Promise.all(
    entries.map(({ filename, content }) =>
      writeFile(join(context.changelogDir, filename), content),
    ),
  );
  s.stop(
    entries.length === 1
      ? "Created 1 changelog file"
      : entries.length > 0
        ? `Created ${entries.length} changelog files`
        : "No changelogs created",
  );

  if (entries.length === 0) {
    note(emptyMessage, "No changelogs created");
  } else {
    const lines: string[] = [];
    for (const { filename, packages } of entries) {
      lines.push(filename);

      for (const [name, config] of Object.entries(packages)) {
        if (typeof config === "string") {
          lines.push(`${name}: ${config}`);
          continue;
        }
        if (config.replay?.length) {
          lines.push(`${name}: ${config.type} (replay on ${config.replay.join(" or ")})`);
          continue;
        }
        lines.push(`${name}: ${config.type}`);
      }
    }
    note(lines.join("\n"), "Created changelogs");
  }

  outro(entries.length === 1 ? "Changelog ready." : "Changelogs ready.");
}

async function promptPackageSelection(graph: PackageGraph, cwd: string): Promise<string[]> {
  const useShortname = new Map<string, boolean>();

  for (const pkg of graph.getPackages()) {
    if (useShortname.has(pkg.name)) useShortname.set(pkg.name, false);
    else useShortname.set(pkg.name, true);
  }

  const getPackageLabel = (pkg: WorkspacePackage) => {
    return useShortname.get(pkg.name) ? pkg.name : pkg.id;
  };

  const changedPackages = new Set(await getChangedPackages(graph, cwd));
  const selectOptions: {
    label: string;
    value: string;
    hint?: string;
  }[] = [];
  const groups: [PackageGroup, changed: boolean][] = [];
  for (const group of graph.getGroups()) {
    const changed = group.packages.some((pkg) => changedPackages.has(pkg));
    groups.push([group, changed]);
  }
  groups.sort((a, b) => (a[1] ? 0 : 1) - (b[1] ? 0 : 1));
  for (const [group, changed] of groups) {
    const members = group.packages.map(getPackageLabel).join(", ");
    selectOptions.push({
      label: `(Group) ${group.name}`,
      value: `group:${group.name}`,
      hint: changed ? `changed · ${members}` : members,
    });
  }

  const packages = graph
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
  return selected;
}

async function promptPackageBumpTypes(
  selectedPackages: string[],
): Promise<Record<string, BumpType>> {
  const packageBumpMap: Record<string, BumpType> = {};
  const bumpType = await select({
    message: "Select release type",
    options: [
      { value: "patch", label: "patch" },
      { value: "minor", label: "minor" },
      { value: "major", label: "major" },
      { value: "per-package", label: "choose per-package" },
    ],
  });
  if (isCancel(bumpType)) throw new CancelledError();

  if (bumpType === "per-package") {
    for (const pkg of selectedPackages) {
      const selectedBump = await select({
        message: `Select release type for "${pkg}"`,
        options: [
          { value: "patch", label: "patch" },
          { value: "minor", label: "minor" },
          { value: "major", label: "major" },
        ],
      });

      if (isCancel(selectedBump)) throw new CancelledError();
      packageBumpMap[pkg] = selectedBump;
    }
  } else {
    for (const pkg of selectedPackages) {
      packageBumpMap[pkg] = bumpType;
    }
  }

  return packageBumpMap;
}
