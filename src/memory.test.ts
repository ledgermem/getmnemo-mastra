import { describe, expect, it, vi, beforeEach } from "vitest";
import { MnemoMemory } from "./memory.js";

const search = vi.fn();
const add = vi.fn();

vi.mock("getmnemo", () => ({
  Mnemo: vi.fn().mockImplementation(() => ({
    search,
    add,
    update: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
  })),
}));

describe("MnemoMemory", () => {
  beforeEach(() => {
    search.mockReset();
    add.mockReset();
    // Core 0.6.0 search returns { results: SearchHit[] } keyed on `memoryId`
    // (unchanged from 0.2; confirmed against prod 2026-06-16).
    search.mockResolvedValue({
      results: [
        {
          memoryId: "m1",
          content: "user prefers TypeScript",
          score: 0.92,
          scopeKey: "user:jane",
        },
      ],
    });
    add.mockResolvedValue({ scopeKey: "user:jane", scope: {}, items: [] });
  });

  it("recalls recent buffer + semantic results (user-scoped container)", async () => {
    const mem = new MnemoMemory({ apiKey: "k", workspaceId: "w" });
    await mem.rememberMessage({
      threadId: "t1",
      resourceId: "jane",
      message: { role: "user", content: "hello" },
    });
    const out = await mem.remember({
      threadId: "t1",
      resourceId: "jane",
      query: "language",
    });
    expect(out.recent).toHaveLength(1);
    expect(out.semantic[0]).toEqual({
      id: "m1",
      content: "user prefers TypeScript",
      score: 0.92,
    });
  });

  it("derives the container tag from resourceId by default (user:<id>)", async () => {
    const mem = new MnemoMemory({ apiKey: "k", workspaceId: "w" });
    await mem.rememberMessage({
      threadId: "t1",
      resourceId: "jane",
      message: { role: "user", content: "hello" },
    });
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ containerTag: "user:jane" }),
    );
    await mem.remember({ threadId: "t1", resourceId: "jane", query: "x" });
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ q: "x", containerTag: "user:jane" }),
    );
  });

  it("uses thread:<id> container when containerScope is 'thread'", async () => {
    const mem = new MnemoMemory({
      apiKey: "k",
      workspaceId: "w",
      containerScope: "thread",
    });
    await mem.rememberMessage({
      threadId: "t1",
      message: { role: "user", content: "hello" },
    });
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ containerTag: "thread:t1" }),
    );
  });

  it("throws when user scope is used without a resourceId", async () => {
    const mem = new MnemoMemory({ apiKey: "k", workspaceId: "w" });
    await expect(
      mem.rememberMessage({
        threadId: "t1",
        message: { role: "user", content: "hello" },
      }),
    ).rejects.toThrow(/requires a resourceId/);
  });

  it("only persists user/assistant messages to Mnemo", async () => {
    const mem = new MnemoMemory({ apiKey: "k", workspaceId: "w" });
    await mem.rememberMessage({
      threadId: "t1",
      resourceId: "jane",
      message: { role: "system", content: "sys prompt" },
    });
    expect(add).not.toHaveBeenCalled();
    await mem.rememberMessage({
      threadId: "t1",
      resourceId: "jane",
      message: { role: "assistant", content: "hi" },
    });
    expect(add).toHaveBeenCalledOnce();
  });

  it("trims working buffer to workingWindow", async () => {
    const mem = new MnemoMemory({
      apiKey: "k",
      workspaceId: "w",
      workingWindow: 2,
    });
    for (const c of ["a", "b", "c"]) {
      await mem.rememberMessage({
        threadId: "t1",
        resourceId: "jane",
        message: { role: "user", content: c },
      });
    }
    const out = await mem.remember({ threadId: "t1", resourceId: "jane" });
    expect(out.recent.map((m) => m.content)).toEqual(["b", "c"]);
  });

  it("skips semantic recall when no query is provided", async () => {
    const mem = new MnemoMemory({ apiKey: "k", workspaceId: "w" });
    const out = await mem.remember({ threadId: "t1", resourceId: "jane" });
    expect(out.semantic).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });

  it("works without workspaceId (deprecated in core 0.6 — identity comes from the API key)", async () => {
    const mem = new MnemoMemory({ apiKey: "k" });
    const out = await mem.remember({
      threadId: "t1",
      resourceId: "jane",
      query: "language",
    });
    expect(out.semantic).toHaveLength(1);
  });

  it("treats a 404 on recall (empty container) as no semantic results", async () => {
    // Mirrors core 0.6's MnemoHTTPError shape: an Error with a `.status`.
    search.mockRejectedValue(
      Object.assign(new Error("[404] Container not found"), { status: 404 }),
    );
    const mem = new MnemoMemory({ apiKey: "k", workspaceId: "w" });
    const out = await mem.remember({
      threadId: "t1",
      resourceId: "brand-new-user",
      query: "anything",
    });
    expect(out.semantic).toEqual([]);
  });

  it("rethrows non-404 recall errors", async () => {
    search.mockRejectedValue(
      Object.assign(new Error("[500] boom"), { status: 500 }),
    );
    const mem = new MnemoMemory({ apiKey: "k", workspaceId: "w" });
    await expect(
      mem.remember({ threadId: "t1", resourceId: "jane", query: "x" }),
    ).rejects.toThrow(/500/);
  });
});
