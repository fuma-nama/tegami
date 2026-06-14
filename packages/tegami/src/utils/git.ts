import { x } from "tinyexec";

/** create a Git tag, ignored if already exists */
export async function createGitTag(cwd: string, tag: string): Promise<void> {
  if (await gitTagExists(cwd, tag)) return;

  await x("git", ["tag", tag], {
    nodeOptions: {
      cwd,
    },
    throwOnError: true,
  });
}

export async function gitTagExists(cwd: string, tag: string): Promise<boolean> {
  const result = await x("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], {
    nodeOptions: {
      cwd,
    },
  });

  return result.exitCode === 0;
}
