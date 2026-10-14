import { Mnemo, type SearchHit } from "getmnemo";

/**
 * How the durable Mnemo container (the tenant-isolation boundary) is derived
 * from the caller-supplied identifiers.
 *
 *  - `"user"` (DEFAULT): container = `user:${resourceId}`. Memories recall
 *    across all of a user's threads — the usual "the agent remembers me
 *    between conversations" behaviour.
 *  - `"thread"`: container = `thread:${threadId}`. Each conversation is a
 *    hard silo; nothing leaks between a user's threads.
 *
 * SECURITY: the container is ALWAYS derived from these developer/server-supplied
 * IDs (`resourceId` / `threadId`). It is NEVER model-chosen and never read from
 * message content — it is the tenant-isolation boundary.
 */
export type ContainerScope = "user" | "thread";

export interface MnemoMemoryOptions {
  client?: Mnemo;
  apiKey?: string;
  /**
   * @deprecated Workspace identity is taken from the API key in core 0.6.
   * Still accepted and forwarded for backwards compatibility.
   */
  workspaceId?: string;
  /**
   * Which identifier owns the durable container (the isolation boundary).
   * Defaults to `"user"` — memories recall across a user's threads. Switch to
   * `"thread"` for per-conversation isolation. See {@link ContainerScope}.
   */
  containerScope?: ContainerScope;
  /** Number of recent messages to keep verbatim in working memory. */
  workingWindow?: number;
  /** Default top-k for semantic recall. */
  recallLimit?: number;
  /**
   * Maximum number of distinct threads to retain in the in-process working
   * buffer. When the limit is exceeded the least-recently-used thread is
   * evicted (its messages are still durable in Mnemo, only the recent
   * cache is dropped). Default: 1000. Long-running servers without this
   * cap leak memory linearly with thread count.
   */
  maxThreads?: number;
}

export interface MemoryMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdAt?: string;
}

export interface MemoryThread {
  threadId: string;
  resourceId?: string;
  messages: MemoryMessage[];
}

export interface MemoryRecallOptions {
  threadId: string;
  resourceId?: string;
  query?: string;
  limit?: number;
}

interface RememberResult {
  threadId: string;
  resourceId?: string;
  recent: MemoryMessage[];
  semantic: Array<{ id: string; content: string; score?: number }>;
}

interface RememberMessageInput {
  threadId: string;
  resourceId?: string;
  message: MemoryMessage;
}

/**
 * Mastra-compatible memory provider backed by Mnemo.
 *
 * Mastra agents call `remember()` before generation and `rememberMessage()`
 * after each turn. This class implements both:
 *
 *  - Short-term recent messages are kept in-process per `threadId` (the
 *    working buffer is always thread-scoped — it mirrors one conversation).
 *  - Long-term semantic recall is delegated to Mnemo, scoped to a durable
 *    container derived from the caller-supplied IDs. By default the container
 *    is the USER (`user:${resourceId}`) so memories recall across a user's
 *    threads; set `containerScope: "thread"` for per-conversation silos.
 *
 * The container tag is the tenant-isolation boundary and is ALWAYS derived
 * from `resourceId`/`threadId` — it is never model-chosen.
 */
export class MnemoMemory {
  private readonly client: Mnemo;
  private readonly containerScope: ContainerScope;
  private readonly workingWindow: number;
  private readonly recallLimit: number;
  private readonly maxThreads: number;
  // Map iteration order is insertion order, so re-inserting on access turns
  // it into a cheap LRU. Bounded so a long-running server doesn't leak.
  private readonly threads = new Map<string, MemoryMessage[]>();

  constructor(options: MnemoMemoryOptions = {}) {
    this.client = resolveClient(options);
    this.containerScope = options.containerScope ?? "user";
    this.workingWindow = options.workingWindow ?? 20;
    this.recallLimit = options.recallLimit ?? 5;
    this.maxThreads = Math.max(1, options.maxThreads ?? 1000);
  }

  /**
   * Pull recent messages plus semantically-relevant memories for a turn.
   * Mastra calls this with the latest user query so semantic recall can
   * use it.
   */
  async remember(opts: MemoryRecallOptions): Promise<RememberResult> {
    const recent = this.getRecent(opts.threadId);
    const query = opts.query?.trim();
    const semantic = query
      ? await this.semanticRecall(query, opts)
      : [];
    return {
      threadId: opts.threadId,
      resourceId: opts.resourceId,
      recent,
      semantic,
    };
  }

  /**
   * Persist a message: always to the working buffer, and to Mnemo
   * for user/assistant turns (system/tool turns are typically noise).
   */
  async rememberMessage(input: RememberMessageInput): Promise<void> {
    this.appendRecent(input.threadId, input.message);
    if (input.message.role !== "user" && input.message.role !== "assistant") {
      return;
    }
    const containerTag = this.containerTagFor(input.threadId, input.resourceId);
    if (!containerTag) {
      throw new Error(
        `MnemoMemory: containerScope="user" requires a resourceId on rememberMessage (thread "${input.threadId}"). Pass resourceId, or set containerScope: "thread".`,
      );
    }
    await this.client.add({
      content: input.message.content,
      // Tenant-isolation boundary — developer-supplied, derived from
      // resourceId/threadId. Never model-chosen.
      containerTag,
      metadata: {
        threadId: input.threadId,
        resourceId: input.resourceId ?? null,
        role: input.message.role,
        createdAt: input.message.createdAt ?? new Date().toISOString(),
      },
    });
  }

  /** Replace the working buffer for a thread (e.g. when loading from disk). */
  setThread(thread: MemoryThread): void {
    this.threads.set(
      thread.threadId,
      thread.messages.slice(-this.workingWindow),
    );
  }

  /** Clear all in-memory threads. Does not delete from Mnemo. */
  reset(): void {
    this.threads.clear();
  }

  /**
   * Derive the durable container tag (isolation boundary) from the
   * caller-supplied IDs. Returns `undefined` only when `containerScope` is
   * `"user"` but no `resourceId` was provided — callers must surface that.
   */
  private containerTagFor(
    threadId: string,
    resourceId?: string,
  ): string | undefined {
    if (this.containerScope === "thread") {
      return `thread:${threadId}`;
    }
    return resourceId ? `user:${resourceId}` : undefined;
  }

  private getRecent(threadId: string): MemoryMessage[] {
    const buf = this.threads.get(threadId);
    if (!buf) return [];
    // Touch the entry so it counts as recently used for the LRU.
    this.threads.delete(threadId);
    this.threads.set(threadId, buf);
    return buf;
  }

  private appendRecent(threadId: string, msg: MemoryMessage): void {
    const existing = this.threads.get(threadId);
    const buf = existing ?? [];
    if (existing) this.threads.delete(threadId);
    const next = [...buf, msg];
    if (next.length > this.workingWindow) {
      next.splice(0, next.length - this.workingWindow);
    }
    this.threads.set(threadId, next);
    while (this.threads.size > this.maxThreads) {
      const oldest = this.threads.keys().next().value;
      if (oldest === undefined) break;
      this.threads.delete(oldest);
    }
  }

  private async semanticRecall(
    query: string,
    opts: MemoryRecallOptions,
  ): Promise<Array<{ id: string; content: string; score?: number }>> {
    const limit = opts.limit ?? this.recallLimit;
    const containerTag = this.containerTagFor(opts.threadId, opts.resourceId);
    if (!containerTag) {
      throw new Error(
        `MnemoMemory: containerScope="user" requires a resourceId on remember (thread "${opts.threadId}"). Pass resourceId, or set containerScope: "thread".`,
      );
    }
    // Over-fetch when we know we're going to filter down — otherwise the
    // thread/resource filter below trims the result set under `limit`,
    // and a noisy container returns near-zero hits even when many memories
    // belong to the requested thread.
    const fetchLimit = Math.max(limit * 4, 20);
    // The container already enforces tenant isolation server-side. When the
    // container is the USER, an extra in-app threadId filter would defeat the
    // point of cross-thread recall — so we only narrow to the current thread
    // when the caller opted into per-thread isolation.
    // confirmed against prod 2026-06-16: `SearchResponse.results` carries the
    // primary hits; `hit.metadata` is `Record<string, unknown> | null`.
    // A brand-new container has no memories yet — the API answers a search
    // against a not-yet-created container with 404 "Container not found". For
    // recall that means "nothing to recall", not a fatal error → treat as empty
    // (otherwise the very first remember() in any new thread/resource throws).
    let results: SearchHit[];
    try {
      ({ results } = await this.client.search({
        q: query,
        containerTag,
        limit: fetchLimit,
      }));
    } catch (err: unknown) {
      if (err instanceof Error && (err as { status?: number }).status === 404) {
        return [];
      }
      throw err;
    }
    const filtered: Array<{ id: string; content: string; score?: number }> = [];
    for (const hit of results) {
      if (this.containerScope === "thread" && !this.matchesThread(hit, opts)) {
        continue;
      }
      filtered.push(toSemanticResult(hit));
      if (filtered.length >= limit) break;
    }
    return filtered;
  }

  /**
   * In per-thread mode, defensively drop hits whose metadata.threadId doesn't
   * match — belt-and-braces on top of the container boundary, in case a memory
   * was written into the same container by another tool without metadata.
   */
  private matchesThread(hit: SearchHit, opts: MemoryRecallOptions): boolean {
    // confirmed against prod 2026-06-16: `metadata` is `Record<string, unknown>
    // | null` on SearchHit; the {threadId, resourceId} shape below is what this
    // SDK writes in `rememberMessage`, not a spec-guaranteed contract.
    const meta = (hit.metadata ?? {}) as Record<string, unknown>;
    if (meta.threadId !== opts.threadId) return false;
    if (
      opts.resourceId !== undefined &&
      meta.resourceId !== undefined &&
      meta.resourceId !== null &&
      meta.resourceId !== opts.resourceId
    ) {
      return false;
    }
    return true;
  }
}

/**
 * Map a core search hit → the wrapper's semantic-result shape.
 * confirmed against prod 2026-06-16: consumes core's `SearchHit`
 * (`memoryId`/`content`/`score`); the hit's id field is `memoryId`.
 */
function toSemanticResult(hit: SearchHit): {
  id: string;
  content: string;
  score?: number;
} {
  return {
    id: hit.memoryId,
    content: hit.content,
    score: typeof hit.score === "number" ? hit.score : undefined,
  };
}

function resolveClient(opts: MnemoMemoryOptions): Mnemo {
  if (opts.client) return opts.client;
  const apiKey = opts.apiKey ?? process.env.GETMNEMO_API_KEY;
  // Deprecated in core 0.6 (workspace identity comes from the API key), but
  // still accepted and forwarded for backwards compatibility.
  const workspaceId = opts.workspaceId ?? process.env.GETMNEMO_WORKSPACE_ID;
  if (!apiKey) {
    throw new Error(
      "MnemoMemory: missing apiKey. Pass it explicitly or set GETMNEMO_API_KEY.",
    );
  }
  return new Mnemo({ apiKey, ...(workspaceId ? { workspaceId } : {}) });
}
