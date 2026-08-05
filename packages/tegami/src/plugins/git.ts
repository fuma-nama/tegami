import { x } from "tinyexec";
import type { TegamiPlugin } from "../types";
import { execFailure } from "../utils/error";
import { isCI } from "../utils/common";
import {
  PackagePublishTask,
  PublishTask,
  type PackagePublishTaskResult,
  type PublishTaskContext,
  type PublishTaskRunContext,
} from "../plans/publish";
import type { WorkspacePackage } from "../graph";

const TAG_PREFIX = "refs/tags/";

export interface GitPluginOptions {
  /** Set to false to skip creating git tags after all packages publish successfully. */
  createTags?: boolean;
  /** Push release tags to origin. Defaults to true in CI. */
  pushTags?: boolean;
}

/** creates and optionally pushes git tags for published packages */
export class GitCreateTagsTask extends PublishTask<{
  createdTags: string[];
}> {
  name = "git:create-tags";
  description = "Create git tags for published packages.";

  constructor(private readonly pushTags = false) {
    super();
  }

  async run(opts: PublishTaskRunContext) {
    const gitOptions = { nodeOptions: { cwd: opts.context.cwd } };
    const { create, push } = await resolvePendingTags(opts, this.pushTags);

    await Promise.all(
      create.map(async (tag) => {
        const gitOut = await x("git", ["tag", tag], gitOptions);

        if (gitOut.exitCode !== 0) {
          throw execFailure(`Failed to create Git tag "${tag}" for release`, gitOut);
        }
      }),
    );

    if (push.length > 0) {
      const gitOut = await x("git", ["push", "origin", ...push], gitOptions);
      // a concurrent release may have pushed the same tags in between, its tags win
      const rejected = gitOut.stderr.match(/^ ! \[rejected].*$/gm);

      if (gitOut.exitCode !== 0 && !rejected?.every((line) => line.includes("already exists"))) {
        throw execFailure(`Failed to push Git tags to origin: ${push.join(", ")}`, gitOut);
      }
    }

    return { createdTags: this.pushTags ? push : create };
  }

  link({ plan }: PublishTaskContext): void {
    for (const t of plan.tasks) {
      // tag-published packages wait for the tags instead (see GitTagPublishTask)
      if (t !== this && t instanceof PackagePublishTask && !(t instanceof GitTagPublishTask)) {
        this.optionalWait.push(t);
      }
    }
  }

  async status(opts: PublishTaskContext) {
    const { create, push } = await resolvePendingTags(opts, this.pushTags);

    if (create.length > 0 || push.length > 0) return "pending";
  }
}

/**
 * Base task for packages published through their git tag (e.g. Go modules):
 * it waits for the git plugin's tag work instead of the tag work waiting for it,
 * fails when the tag work failed, and reports `skipped` when its tag already existed.
 */
export abstract class GitTagPublishTask<
  T extends WorkspacePackage = WorkspacePackage,
> extends PackagePublishTask<T> {
  link(opts: PublishTaskContext): void {
    super.link(opts);
    for (const t of opts.plan.tasks) {
      if (t instanceof GitCreateTagsTask) this.wait.push(t);
    }
  }

  /** `published` when this run created the package's tag, `skipped` when the tag already existed */
  async publish({ plan }: PublishTaskRunContext): Promise<PackagePublishTaskResult> {
    const createTags = plan.tasks.find(
      (t): t is GitCreateTagsTask => t instanceof GitCreateTagsTask,
    );
    const created = createTags?.getResult();
    if (!created) throw new Error(`Git tags were not created for package "${this.pkg.name}".`);
    if (created.status === "failed") throw created.error;

    const tag = plan.packages.get(this.pkg.id)?.git?.tag;
    if (!tag || !created.result.createdTags.includes(tag)) return { type: "skipped" };
    return { type: "published" };
  }
}

/**
 * The release tags of the plan that are still missing, tags already present on origin are
 * left untouched: the release they point at is out of our hands.
 */
async function resolvePendingTags(
  { plan, context }: PublishTaskContext,
  pushTags: boolean,
): Promise<{
  /** tags to create in the local repository */
  create: string[];
  /** tags to push to origin */
  push: string[];
}> {
  const create: string[] = [];
  const push: string[] = [];
  const tags = new Set<string>();

  for (const pkg of plan.packages.values()) {
    if (!pkg.preflight!.shouldPublish) continue;
    if (pkg.publishResult && pkg.publishResult.type === "failed") continue;

    const tag = pkg.git?.tag;
    if (tag) tags.add(tag);
  }
  if (tags.size === 0) return { create, push };

  const gitOptions = { nodeOptions: { cwd: context.cwd } };
  const refs = Array.from(tags, (tag) => `${TAG_PREFIX}${tag}`);
  const [local, remote] = await Promise.all([
    // tag names cannot contain glob characters, hence the patterns are exact matches
    x("git", ["tag", "--list", ...tags], gitOptions),
    x("git", ["ls-remote", "--tags", "origin", ...refs], gitOptions),
  ]);

  if (local.exitCode !== 0) throw execFailure("Failed to list local Git tags", local);

  const localTags = new Set(local.stdout.split("\n").map((line) => line.trim()));
  const originTags = new Set<string>();
  // an unreachable origin is treated as having no tags, pushing them reports the actual error
  for (const line of remote.exitCode === 0 ? remote.stdout.split("\n") : []) {
    // `<sha>\t<ref>`, annotated tags are listed again as their peeled `<ref>^{}`
    const ref = line.split("\t")[1]?.trim();
    if (ref?.startsWith(TAG_PREFIX)) {
      originTags.add(ref.slice(TAG_PREFIX.length).replace(/\^\{\}$/, ""));
    }
  }

  for (const tag of tags) {
    if (originTags.has(tag)) continue;

    if (!localTags.has(tag)) create.push(tag);
    if (pushTags) push.push(tag);
  }

  return { create, push };
}

/**
 * Basic Git integrations:
 * - auto tags.
 *
 * Note: you do not need this with `github` plugin enabled.
 */
export function git(options: GitPluginOptions = {}): TegamiPlugin {
  const { createTags = true, pushTags = isCI() } = options;

  return {
    name: "git",
    async initCli() {
      if (!isCI()) return;

      const gitOptions = { nodeOptions: { cwd: this.cwd } };

      for (const args of [
        ["config", "user.name", "github-actions[bot]"],
        ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"],
      ] as const) {
        const result = await x("git", args, gitOptions);
        if (result.exitCode !== 0) {
          throw execFailure("Failed to configure git user for GitHub Actions.", result);
        }
      }
    },
    initPublishPlan({ plan }) {
      const { graph } = this;

      for (const [id, packagePlan] of plan.packages) {
        const pkg = graph.get(id)!;
        const git = (packagePlan.git ??= {});
        if (pkg.version)
          git.tag ??= pkg.group?.options.syncGitTag
            ? `${pkg.group.name}@${pkg.version}`
            : `${pkg.name}@${pkg.version}`;
      }
    },
    publishTasks({ plan }) {
      const dryRun = plan.options.dryRun ?? false;
      if (!createTags || dryRun) return;
      return new GitCreateTagsTask(pushTags);
    },
  };
}
