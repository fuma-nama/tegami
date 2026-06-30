import { afterEach, describe, expect, test, vi } from "vitest";
import {
  findMergeRequestCommentByPrefix,
  releaseExistsByTag,
  updateMergeRequest,
  updateMergeRequestComment,
} from "../src/plugins/gitlab/api";

const fetchMock = vi.fn<typeof fetch>();

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("gitlab api", () => {
  test("checks release existence with HEAD", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    await expect(
      releaseExistsByTag("acme/repo", "v1.0.0", {
        token: { value: "token", type: "private-token" },
      }),
    ).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://gitlab.com/api/v4/projects/acme%2Frepo/releases/v1.0.0",
      expect.objectContaining({ method: "HEAD" }),
    );
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init!.headers as Headers).get("PRIVATE-TOKEN")).toBe("token");
  });

  test("uses JOB-TOKEN header for CI job tokens", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    await expect(
      releaseExistsByTag("acme/repo", "v1.0.0", {
        token: { value: "job-token", type: "job-token" },
      }),
    ).resolves.toBe(true);

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init!.headers as Headers;
    expect(headers.get("JOB-TOKEN")).toBe("job-token");
    expect(headers.get("PRIVATE-TOKEN")).toBeNull();
  });

  test("stops listing merge request comments once the matching marker is found", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify([
          { id: 1, body: "ordinary comment" },
          { id: 2, body: "<!-- tegami -->\npreview" },
        ]),
        { status: 200 },
      ),
    );

    await expect(findMergeRequestCommentByPrefix("acme/repo", 42, "<!-- tegami -->")).resolves.toBe(
      2,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gitlab.com/api/v4/projects/acme%2Frepo/merge_requests/42/notes?per_page=100&page=1",
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
  });

  test("updates merge request comments through the project-scoped note endpoint", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

    await updateMergeRequestComment("acme/repo", 42, 12345, "<!-- tegami -->\npreview", {
      token: { value: "token", type: "private-token" },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://gitlab.com/api/v4/projects/acme%2Frepo/merge_requests/42/notes/12345",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ body: "<!-- tegami -->\npreview" }),
      }),
    );
  });

  test("updates merge request target branch when a base branch is supplied", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

    await updateMergeRequest("acme/repo", 42, {
      title: "Version Packages",
      body: "Release notes",
      base: "release",
      token: { value: "token", type: "private-token" },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://gitlab.com/api/v4/projects/acme%2Frepo/merge_requests/42",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          title: "Version Packages",
          description: "Release notes",
          target_branch: "release",
        }),
      }),
    );
  });
});
