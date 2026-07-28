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
import { changelogFilename, generateFromCommits } from "../changelog/generate";
import type { PackageGroup, PackageGraph, WorkspacePackage } from "../graph";
import type { TegamiContext } from "../context";
import { isCI } from "../utils/common";
import { CancelledError } from "../utils/error";
import { getChangedPackages } from "../utils/git-changes";
import type { BumpType } from "../utils/semver";
import { type ChangelogPackageConfig, renderChangelog } from "../changelog/shared";

export async function runChangelogTui(tegami: Tegami): Promise<void> {
  const context = await tegami._internal.context();
  intro("Create changelogs");

  if (isCI()) {
    await persistCommitChangelogs(context);
    return;
  }

  const versionablePackages = context.graph
    .getPackages()
    .filter((pkg) => pkg.version !== undefined);
  // a single-package workspace has nothing to select
  const soloPackage = versionablePackages.length === 1 ? versionablePackages[0] : undefined;
  let selectedPackages: string[];

  if (soloPackage) {
    selectedPackages = [soloPackage.id];
  } else {
    selectedPackages = await promptPackageSelection(
      context.graph,
      versionablePackages,
      context.cwd,
    );

    if (selectedPackages.length === 0) {
      const confirmed = await confirm({
        message: "Auto-generate changelog files from commits?",
        initialValue: true,
      });
      if (isCancel(confirmed)) throw new CancelledError();

      if (!confirmed) {
        outro("No changelogs created.");
        return;
      }

      await persistCommitChangelogs(context);
      return;
    }
  }

  const packageBumpMap = await promptPackageBumpTypes(selectedPackages, {
    // skipping the selector also skips its empty-selection shortcut, offer it here instead
    allowCommits: soloPackage !== undefined,
  });

  if (packageBumpMap === "from-commits") {
    await persistCommitChangelogs(context);
    return;
  }

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
  await persistChangelogs(context, [
    {
      filename,
      content: renderChangelog({ packages: packageBumpMap }, `## ${message.trim()}`),
      packages: packageBumpMap,
    },
  ]);
}

async function persistCommitChangelogs(context: TegamiContext): Promise<void> {
  const created = await generateFromCommits(context);
  await persistChangelogs(
    context,
    created.map(({ filename, content, packages }) => ({ filename, content, packages })),
    "No matching conventional commits were found.",
  );
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

async function promptPackageSelection(
  graph: PackageGraph,
  versionablePackages: WorkspacePackage[],
  cwd: string,
): Promise<string[]> {
  const useShortname = new Map<string, boolean>();

  for (const pkg of versionablePackages) {
    if (useShortname.has(pkg.name)) useShortname.set(pkg.name, false);
    else useShortname.set(pkg.name, true);
  }

  const getPackageLabel = (pkg: WorkspacePackage) => {
    return useShortname.get(pkg.name) ? pkg.name : pkg.id;
  };

  const changedPackages = await getChangedPackages(versionablePackages, cwd);
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
    selectOptions.push({
      label: `(Group) ${group.name}` + (changed ? "*" : ""),
      value: `group:${group.name}`,
      hint: group.packages.map(getPackageLabel).join(", "),
    });
  }

  for (const pkg of versionablePackages.sort(
    (a, b) => (changedPackages.has(a) ? 0 : 1) - (changedPackages.has(b) ? 0 : 1),
  )) {
    selectOptions.push({
      label: getPackageLabel(pkg) + (changedPackages.has(pkg) ? "*" : ""),
      value: pkg.id,
    });
  }

  const selected = await autocompleteMultiselect({
    message: "Select packages (leave empty to auto-generate from commits)",
    required: false,
    options: selectOptions,
    initialValues: Array.from(changedPackages, (pkg) => pkg.id),
  });

  if (isCancel(selected)) throw new CancelledError();
  return selected;
}

const bumpOptions: { value: BumpType; label: string }[] = [
  { value: "patch", label: "patch" },
  { value: "minor", label: "minor" },
  { value: "major", label: "major" },
];

async function promptPackageBumpTypes(
  selectedPackages: string[],
  { allowCommits = false }: { allowCommits?: boolean } = {},
): Promise<Record<string, BumpType> | "from-commits"> {
  const options: { value: BumpType | "per-package" | "from-commits"; label: string }[] = [
    ...bumpOptions,
  ];
  if (selectedPackages.length > 1)
    options.push({ value: "per-package", label: "choose per-package" });
  if (allowCommits) options.push({ value: "from-commits", label: "auto-generate from commits" });

  const bumpType = await select({
    message:
      selectedPackages.length === 1
        ? `Select release type for "${selectedPackages[0]}"`
        : "Select release type",
    options,
  });
  if (isCancel(bumpType)) throw new CancelledError();
  if (bumpType === "from-commits") return "from-commits";

  const packageBumpMap: Record<string, BumpType> = {};

  if (bumpType === "per-package") {
    for (const pkg of selectedPackages) {
      const selectedBump = await select({
        message: `Select release type for "${pkg}"`,
        options: bumpOptions,
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
