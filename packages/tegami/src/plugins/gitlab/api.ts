export function parseGitLabRepo(repo: string): { projectPath: string; encodedProjectPath: string } {
  const projectPath = repo.replace(/^\/+|\/+$/g, "");
  if (!projectPath || !projectPath.includes("/")) {
    throw new Error(`Invalid GitLab repository: ${repo}`);
  }

  return {
    projectPath,
    encodedProjectPath: encodeURIComponent(projectPath),
  };
}

export function gitlabApiUrl(apiUrl = "https://gitlab.com/api/v4"): string {
  return apiUrl.replace(/\/+$/, "");
}

export function gitlabWebUrl(webUrl = "https://gitlab.com"): string {
  return webUrl.replace(/\/+$/, "");
}

export interface GitLabToken {
  value: string;
  type: "private-token" | "job-token";
}

export interface GitLabRequestOptions {
  apiUrl?: string;
  token?: GitLabToken;
}

async function gitlabRequest(
  options: GitLabRequestOptions,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (options.token) {
    headers.set(
      options.token.type === "job-token" ? "JOB-TOKEN" : "PRIVATE-TOKEN",
      options.token.value,
    );
  }

  return fetch(`${gitlabApiUrl(options.apiUrl)}${path}`, { ...init, headers });
}

export async function releaseExistsByTag(
  repo: string,
  tag: string,
  options: GitLabRequestOptions = {},
): Promise<boolean> {
  const { encodedProjectPath } = parseGitLabRepo(repo);
  const response = await gitlabRequest(
    options,
    `/projects/${encodedProjectPath}/releases/${encodeURIComponent(tag)}`,
    { method: "HEAD" },
  );

  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(`Failed to get GitLab release for ${tag}.`);
  }

  return true;
}

export async function createRelease(
  repo: string,
  options: {
    tag: string;
    title: string;
    notes: string;
  } & GitLabRequestOptions,
): Promise<void> {
  const { encodedProjectPath } = parseGitLabRepo(repo);
  const response = await gitlabRequest(options, `/projects/${encodedProjectPath}/releases`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tag_name: options.tag,
      name: options.title,
      description: options.notes,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to create GitLab release for ${options.tag}.`);
  }
}

export async function findOpenMergeRequest(
  repo: string,
  options: {
    head: string;
    base?: string;
  } & GitLabRequestOptions,
): Promise<number | undefined> {
  const { encodedProjectPath } = parseGitLabRepo(repo);
  const params = new URLSearchParams({
    source_branch: options.head,
    state: "opened",
  });
  if (options.base) params.set("target_branch", options.base);

  const response = await gitlabRequest(
    options,
    `/projects/${encodedProjectPath}/merge_requests?${params}`,
  );

  if (!response.ok) {
    throw new Error("Failed to check for an existing version merge request.");
  }

  const mergeRequests = (await response.json()) as Array<{ iid: number }>;
  return mergeRequests[0]?.iid;
}

export async function updateMergeRequest(
  repo: string,
  number: number,
  options: {
    title: string;
    body: string;
    base?: string;
  } & GitLabRequestOptions,
): Promise<void> {
  const { encodedProjectPath } = parseGitLabRepo(repo);
  const response = await gitlabRequest(
    options,
    `/projects/${encodedProjectPath}/merge_requests/${number}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: options.title,
        description: options.body,
        target_branch: options.base,
      }),
    },
  );

  if (!response.ok) {
    throw new Error("Failed to update the version merge request.");
  }
}

export async function createMergeRequest(
  repo: string,
  options: {
    title: string;
    body: string;
    head: string;
    base: string;
  } & GitLabRequestOptions,
): Promise<void> {
  const { encodedProjectPath } = parseGitLabRepo(repo);
  const response = await gitlabRequest(options, `/projects/${encodedProjectPath}/merge_requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: options.title,
      description: options.body,
      source_branch: options.head,
      target_branch: options.base,
    }),
  });

  if (!response.ok) {
    throw new Error("Failed to create the version merge request.");
  }
}

export async function getMergeRequest(
  repo: string,
  number: number,
  options: GitLabRequestOptions = {},
): Promise<{
  sourceBranch: string;
  sourceProjectPath?: string;
  baseSha: string;
  headSha: string;
}> {
  const { encodedProjectPath } = parseGitLabRepo(repo);
  const response = await gitlabRequest(
    options,
    `/projects/${encodedProjectPath}/merge_requests/${number}`,
  );

  if (!response.ok) {
    throw new Error(`Failed to resolve merge request !${number}.`);
  }

  const data = (await response.json()) as {
    source_branch: string;
    source_project_id?: number;
    diff_refs?: { base_sha?: string; head_sha?: string };
    sha?: string;
  };

  let sourceProjectPath: string | undefined;
  if (data.source_project_id !== undefined) {
    const projectResponse = await gitlabRequest(options, `/projects/${data.source_project_id}`);
    if (projectResponse.ok) {
      const project = (await projectResponse.json()) as { path_with_namespace?: string };
      sourceProjectPath = project.path_with_namespace;
    }
  }

  return {
    sourceBranch: data.source_branch,
    sourceProjectPath,
    baseSha: data.diff_refs?.base_sha ?? "",
    headSha: data.diff_refs?.head_sha ?? data.sha ?? "",
  };
}

export interface MergeRequestSummary {
  number: number;
  title: string;
  user?: { login: string };
}

export async function listMergeRequestsForCommit(
  repo: string,
  commitSha: string,
  options: GitLabRequestOptions = {},
): Promise<MergeRequestSummary[]> {
  const { encodedProjectPath } = parseGitLabRepo(repo);
  const response = await gitlabRequest(
    options,
    `/projects/${encodedProjectPath}/repository/commits/${commitSha}/merge_requests`,
  );

  if (!response.ok) {
    throw new Error(`Failed to list merge requests for commit ${commitSha.slice(0, 7)}.`);
  }

  const mergeRequests = (await response.json()) as Array<{
    iid: number;
    title: string;
    author?: { username: string };
  }>;

  return mergeRequests.map((mergeRequest) => ({
    number: mergeRequest.iid,
    title: mergeRequest.title,
    user: mergeRequest.author ? { login: mergeRequest.author.username } : undefined,
  }));
}

export async function findMergeRequestCommentByPrefix(
  repo: string,
  mergeRequestNumber: number,
  prefix: string,
  options: GitLabRequestOptions = {},
): Promise<number | undefined> {
  const { encodedProjectPath } = parseGitLabRepo(repo);
  let page = 1;

  while (true) {
    const response = await gitlabRequest(
      options,
      `/projects/${encodedProjectPath}/merge_requests/${mergeRequestNumber}/notes?per_page=100&page=${page}`,
    );

    if (!response.ok) {
      throw new Error("Failed to list merge request comments.");
    }

    const batch = (await response.json()) as Array<{ id: number; body: string }>;
    if (batch.length === 0) break;

    const comment = batch.find((comment) => comment.body.startsWith(prefix));
    if (comment) return comment.id;

    if (batch.length < 100) break;
    page += 1;
  }
}

export async function updateMergeRequestComment(
  repo: string,
  mergeRequestNumber: number,
  commentId: number,
  body: string,
  options: GitLabRequestOptions = {},
): Promise<void> {
  const { encodedProjectPath } = parseGitLabRepo(repo);
  const response = await gitlabRequest(
    options,
    `/projects/${encodedProjectPath}/merge_requests/${mergeRequestNumber}/notes/${commentId}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    },
  );

  if (!response.ok) {
    throw new Error("Failed to update merge request comment.");
  }
}

export async function createMergeRequestComment(
  repo: string,
  mergeRequestNumber: number,
  body: string,
  options: GitLabRequestOptions = {},
): Promise<void> {
  const { encodedProjectPath } = parseGitLabRepo(repo);
  const response = await gitlabRequest(
    options,
    `/projects/${encodedProjectPath}/merge_requests/${mergeRequestNumber}/notes`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    },
  );

  if (!response.ok) {
    throw new Error("Failed to create merge request comment.");
  }
}
