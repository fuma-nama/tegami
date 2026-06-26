export function parseGitHubRepo(repo: string): { owner: string; repo: string } {
  const [owner, name] = repo.split("/", 2);
  if (!owner || !name) {
    throw new Error(`Invalid GitHub repository: ${repo}`);
  }

  return { owner, repo: name };
}

async function githubRequest(
  path: string,
  token: string | undefined,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  return fetch(`https://api.github.com${path}`, { ...init, headers });
}

export async function getReleaseByTag(
  repo: string,
  tag: string,
  token?: string,
): Promise<{ id: number } | null> {
  const { owner, repo: name } = parseGitHubRepo(repo);
  const response = await githubRequest(
    `/repos/${owner}/${name}/releases/tags/${encodeURIComponent(tag)}`,
    token,
  );

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Failed to get GitHub release for ${tag}.`);
  }

  return response.json() as Promise<{ id: number }>;
}

export async function createRelease(
  repo: string,
  options: {
    tag: string;
    title: string;
    notes: string;
    prerelease?: boolean;
    token?: string;
  },
): Promise<void> {
  const { owner, repo: name } = parseGitHubRepo(repo);
  const response = await githubRequest(`/repos/${owner}/${name}/releases`, options.token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tag_name: options.tag,
      name: options.title,
      body: options.notes,
      prerelease: options.prerelease ?? false,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to create GitHub release for ${options.tag}.`);
  }
}

export async function findOpenPullRequest(
  repo: string,
  headBranch: string,
  token?: string,
): Promise<number | undefined> {
  const { owner, repo: name } = parseGitHubRepo(repo);
  const params = new URLSearchParams({
    head: `${owner}:${headBranch}`,
    state: "open",
  });
  const response = await githubRequest(`/repos/${owner}/${name}/pulls?${params}`, token);

  if (!response.ok) {
    throw new Error("Failed to check for an existing version pull request.");
  }

  const pullRequests = (await response.json()) as Array<{ number: number }>;
  return pullRequests[0]?.number;
}

export async function updatePullRequest(
  repo: string,
  number: number,
  options: { title: string; body: string; token?: string },
): Promise<void> {
  const { owner, repo: name } = parseGitHubRepo(repo);
  const response = await githubRequest(`/repos/${owner}/${name}/pulls/${number}`, options.token, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: options.title,
      body: options.body,
    }),
  });

  if (!response.ok) {
    throw new Error("Failed to update the version pull request.");
  }
}

export async function createPullRequest(
  repo: string,
  options: {
    title: string;
    body: string;
    head: string;
    base: string;
    token?: string;
  },
): Promise<void> {
  const { owner, repo: name } = parseGitHubRepo(repo);
  const response = await githubRequest(`/repos/${owner}/${name}/pulls`, options.token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: options.title,
      body: options.body,
      head: options.head,
      base: options.base,
    }),
  });

  if (!response.ok) {
    throw new Error("Failed to create the version pull request.");
  }
}

export async function getPullRequest(
  repo: string,
  number: number,
  token?: string,
): Promise<{
  headRefName: string;
  baseRefOid: string;
  headRefOid: string;
  headRepository?: { name: string; owner: { login: string } } | null;
}> {
  const { owner, repo: name } = parseGitHubRepo(repo);
  const response = await githubRequest(`/repos/${owner}/${name}/pulls/${number}`, token);

  if (!response.ok) {
    throw new Error(`Failed to resolve pull request #${number}.`);
  }

  const data = (await response.json()) as {
    head: { ref: string; sha: string; repo: { name: string; owner: { login: string } } | null };
    base: { sha: string };
  };

  return {
    headRefName: data.head.ref,
    baseRefOid: data.base.sha,
    headRefOid: data.head.sha,
    headRepository: data.head.repo,
  };
}

export async function findIssueCommentByPrefix(
  repo: string,
  issueNumber: number,
  prefix: string,
  token?: string,
): Promise<number | undefined> {
  const { owner, repo: name } = parseGitHubRepo(repo);
  let page = 1;

  while (true) {
    const response = await githubRequest(
      `/repos/${owner}/${name}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
      token,
    );

    if (!response.ok) {
      throw new Error("Failed to list pull request comments.");
    }

    const batch = (await response.json()) as Array<{ id: number; body: string }>;
    if (batch.length === 0) break;

    const comment = batch.find((comment) => comment.body.startsWith(prefix));
    if (comment) return comment.id;

    if (batch.length < 100) break;
    page += 1;
  }
}

export async function updateIssueComment(
  repo: string,
  commentId: number,
  body: string,
  token?: string,
): Promise<void> {
  const { owner, repo: name } = parseGitHubRepo(repo);
  const response = await githubRequest(
    `/repos/${owner}/${name}/issues/comments/${commentId}`,
    token,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    },
  );

  if (!response.ok) {
    throw new Error("Failed to update pull request comment.");
  }
}

export async function createIssueComment(
  repo: string,
  issueNumber: number,
  body: string,
  token?: string,
): Promise<void> {
  const { owner, repo: name } = parseGitHubRepo(repo);
  const response = await githubRequest(
    `/repos/${owner}/${name}/issues/${issueNumber}/comments`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    },
  );

  if (!response.ok) {
    throw new Error("Failed to create pull request comment.");
  }
}
