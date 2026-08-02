import { x } from "tinyexec";
import type { TegamiPlugin } from "../types";
import { execFailure } from "../utils/error";
import { isCI, somePromise } from "../utils/common";
import {
  PackagePublishTask,
  PublishTask,
  type PackagePublishTaskResult,
  type PublishPlan,
  type PublishTaskContext,
  type PublishTaskRunContext,
} from "../plans/publish";
import type { WorkspacePackage } from "../graph";

export interface GitPluginOptions {
  /** Set to false to skip creating git tags after all packages publish successfully. */
  createTags?: boolean;
  /** Push created tags to origin. Defaults to true in CI. */
  pushTags?: boolean;
}

/** creates git tags for published packages */
export class GitCreateTagsTask extends PublishTask<{
  createdTags: string[];
  tagsToPush: string[];
}> {
  name = "git:create-tags";
  description = "Create git tags for published packages.";

  async run({ plan, context }: PublishTaskRunContext) {
    const createdTags: string[] = [];
    const tagsToPush: string[] = [];
    const pendingTags = getPendingTags(plan);
    if (pendingTags.size === 0) return { createdTags, tagsToPush };

    await Promise.all(
      Array.from(pendingTags, async (tag) => {
        const gitOut = await x("git", ["tag", tag], {
          nodeOptions: { cwd: context.cwd },
        });

        if (gitOut.exitCode !== 0) {
          if (/already exists/i.test(`${gitOut.stdout}\n${gitOut.stderr}`)) {
            // A previous attempt may have created this locally before another tag failed.
            // Keep it in the push set so the retry cannot strand the tag locally.
            tagsToPush.push(tag);
            return;
          }

          throw execFailure(`Failed to create Git tag "${tag}" for release`, gitOut);
        }

        createdTags.push(tag);
        tagsToPush.push(tag);
      }),
    );

    return {
      createdTags,
      tagsToPush,
    };
  }

  link({ plan }: PublishTaskContext): void {
    for (const t of plan.tasks) {
      // tag-published packages wait for the tags instead (see GitTagPublishTask)
      if (t !== this && t instanceof PackagePublishTask && !(t instanceof GitTagPublishTask)) {
        this.optionalWait.push(t);
      }
    }
  }

  async status({ plan, context }: PublishTaskContext) {
    const pendingTags = getPendingTags(plan);

    const checks = Array.from(pendingTags, async (tag) => {
      const local = await x("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], {
        nodeOptions: { cwd: context.cwd },
      });
      if (local.exitCode === 0) return false;

      // check from remote if `git pull` is not necessarily ran.
      const origin = await x(
        "git",
        ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`],
        { nodeOptions: { cwd: context.cwd } },
      );

      return origin.exitCode !== 0;
    });

    if (await somePromise(checks, (missing) => missing)) return "pending";
  }
}

/** pushes created git tags to origin */
export class GitPushTagsTask extends PublishTask<void> {
  name = "git:push-tags";
  description = "Push created git tags to origin.";

  constructor(private readonly createTags: GitCreateTagsTask) {
    super();
    this.wait.push(createTags);
  }

  async run({ context }: PublishTaskRunContext) {
    const created = this.createTags.getResult();
    const tagsToPush = created?.status === "success" ? created.result.tagsToPush : [];
    if (tagsToPush.length === 0) return;

    const gitOut = await x("git", ["push", "origin", ...tagsToPush], {
      nodeOptions: { cwd: context.cwd },
    });

    if (gitOut.exitCode !== 0) {
      // this can happen in two concurrent runs: one of it pushed the tags, while another one just passed `git tag` but not pushed yet.
      if (
        /already exists/i.test(`${gitOut.stdout}\n${gitOut.stderr}`) &&
        (await Promise.all(tagsToPush.map((tag) => remoteTagMatches(context.cwd, tag)))).every(
          Boolean,
        )
      ) {
        return;
      }

      throw execFailure(`Failed to push Git tags to origin: ${tagsToPush.join(", ")}`, gitOut);
    }
  }

  async status({ plan, context }: PublishTaskContext) {
    const checks = Array.from(getPendingTags(plan), async (tag) => {
      const origin = await x(
        "git",
        ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`],
        { nodeOptions: { cwd: context.cwd } },
      );
      return origin.exitCode !== 0;
    });

    if (await somePromise(checks, (missing) => missing)) return "pending" as const;
  }
}

async function remoteTagMatches(cwd: string, tag: string): Promise<boolean> {
  const [local, remote] = await Promise.all([
    x("git", ["rev-parse", `refs/tags/${tag}^{}`], { nodeOptions: { cwd } }),
    x("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`], {
      nodeOptions: { cwd },
    }),
  ]);
  if (local.exitCode !== 0 || remote.exitCode !== 0) return false;

  const remoteRefs = new Map(
    remote.stdout
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/, 2) as [string, string])
      .map(([sha, ref]) => [ref, sha]),
  );
  const remoteSha = remoteRefs.get(`refs/tags/${tag}^{}`) ?? remoteRefs.get(`refs/tags/${tag}`);
  return remoteSha !== undefined && remoteSha === local.stdout.trim();
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
      if (t instanceof GitCreateTagsTask || t instanceof GitPushTagsTask) this.wait.push(t);
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

function getPendingTags(plan: PublishPlan) {
  const pendingTags = new Set<string>();
  for (const pkg of plan.packages.values()) {
    if (!pkg.preflight!.shouldPublish) continue;
    if (pkg.publishResult && pkg.publishResult.type === "failed") continue;

    const tag = pkg.git?.tag;
    if (tag) pendingTags.add(tag);
  }
  return pendingTags;
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

      const createTask = new GitCreateTagsTask();
      const tasks: PublishTask[] = [createTask];
      if (pushTags) tasks.push(new GitPushTagsTask(createTask));

      return tasks;
    },
  };
}
