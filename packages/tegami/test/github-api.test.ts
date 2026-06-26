import { afterEach, describe, expect, test, vi } from "vitest";
import {
  findIssueCommentByPrefix,
  releaseExistsByTag,
  updateIssueComment,
} from "../src/plugins/github/api";

const fetchMock = vi.fn<typeof fetch>();

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("github api", () => {
  test("checks release existence with HEAD", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    await expect(releaseExistsByTag("acme/repo", "v1.0.0", "token")).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/repo/releases/tags/v1.0.0",
      expect.objectContaining({ method: "HEAD" }),
    );
  });

  test("stops listing comments once the matching marker is found", async () => {
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

    await expect(findIssueCommentByPrefix("acme/repo", 42, "<!-- tegami -->")).resolves.toBe(2);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/repo/issues/42/comments?per_page=100&page=1",
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
  });

  test("updates comments through the repository-scoped issue comment endpoint", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

    await updateIssueComment("acme/repo", 12345, "<!-- tegami -->\npreview", "token");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/repo/issues/comments/12345",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ body: "<!-- tegami -->\npreview" }),
      }),
    );
  });
});
