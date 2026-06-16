# getmnemo-mastra

[Mnemo](https://mnemohq.com)-backed memory provider for [Mastra](https://mastra.ai) agents.
Combines a thread-scoped short-term buffer with semantic long-term recall.

## Install

```bash
npm install getmnemo-mastra @mastra/core
```

`getmnemo` (the core SDK) is bundled as a dependency, so it is installed for you.

Set `GETMNEMO_API_KEY` and `GETMNEMO_WORKSPACE_ID`, or pass them in explicitly.

> **Security:** the `apiKey` is **full-access** by default — keep it server-side.
> For client-exposed contexts, mint a **scoped read-only key** at
> [app.mnemohq.com/settings/api-keys](https://app.mnemohq.com/settings/api-keys)
> and pass that instead.

## Container scope (the isolation boundary)

Every memory lives in a durable **container** — the tenant-isolation boundary.
`MnemoMemory` derives the container tag server-side from the
**caller-supplied** `resourceId` / `threadId`. It is **never model-chosen** and
never read from message content.

`containerScope` (default `"user"`) controls which identifier owns the container:

| `containerScope` | Container tag         | Behaviour                                                              | Requires      |
| ---------------- | --------------------- | --------------------------------------------------------------------- | ------------- |
| `"user"` (default) | `user:${resourceId}`  | Cross-thread recall — the agent remembers a user across conversations | `resourceId`  |
| `"thread"`         | `thread:${threadId}`  | Per-conversation silo — nothing leaks between a user's threads        | `threadId`    |

`threadId` **always** scopes the in-process short-term working buffer, regardless
of `containerScope`. When `containerScope` is `"user"`, a `resourceId` is
**required** on `remember()` and `rememberMessage()` — calls without one throw.

## Quickstart (30 seconds)

`MnemoMemory` is a standalone memory store: you call `rememberMessage()` after
each turn to persist it, and `remember()` before generation to pull recent
messages plus semantically-relevant memories back. Feed those into your Mastra
agent's prompt.

```ts
import { Agent } from "@mastra/core/agent";
import { openai } from "@ai-sdk/openai";
import { MnemoMemory } from "getmnemo-mastra";

// Reads GETMNEMO_API_KEY / GETMNEMO_WORKSPACE_ID from the environment,
// or pass { apiKey, workspaceId } explicitly. Defaults to containerScope: "user".
const memory = new MnemoMemory({ workingWindow: 20, recallLimit: 5 });

const agent = new Agent({
  name: "support",
  instructions: "Use long-term memory to personalize responses.",
  model: openai("gpt-4o"),
});

const threadId = "conversation-123";
const resourceId = "user-42"; // required in the default "user" scope

// 1. Persist the incoming user turn.
const userMessage = "Remember that I prefer concise answers.";
await memory.rememberMessage({
  threadId,
  resourceId,
  message: { role: "user", content: userMessage },
});

// 2. Recall recent + semantic context for this turn.
//    Search uses `q` under the hood — pass the latest query here.
const { recent, semantic } = await memory.remember({
  threadId,
  resourceId,
  query: userMessage,
});

// 3. Hand the recalled context to the agent.
const recalled = semantic.map((m) => m.content).join("\n");
const result = await agent.generate(
  `Relevant memories:\n${recalled}\n\nUser: ${userMessage}`,
);

// 4. Persist the assistant turn so it's available next time.
await memory.rememberMessage({
  threadId,
  resourceId,
  message: { role: "assistant", content: result.text },
});
```

### Per-conversation isolation

Set `containerScope: "thread"` to silo each conversation. `resourceId` becomes
optional and recall never crosses thread boundaries:

```ts
const memory = new MnemoMemory({ containerScope: "thread" });

await memory.rememberMessage({
  threadId: "conversation-123",
  message: { role: "user", content: "This stays in this thread only." },
});
```

## Using your own Mnemo client

Pass an existing `Mnemo` instance instead of credentials:

```ts
import { Mnemo } from "getmnemo";
import { MnemoMemory } from "getmnemo-mastra";

const client = new Mnemo({ apiKey, workspaceId });
const memory = new MnemoMemory({ client, recallLimit: 8 });
```

## What you get

- `remember({ threadId, resourceId?, query?, limit? })` — recent messages from
  the working buffer plus top-k semantic hits. Semantic recall runs only when a
  `query` is provided. In `"user"` scope, recall spans all of the user's threads
  (a `resourceId` is required); in `"thread"` scope, hits are additionally
  filtered to the requested `threadId` to prevent cross-thread context bleed.
  Returns `{ threadId, resourceId?, recent, semantic }`, where each `semantic`
  hit is `{ id, content, score? }`.
- `rememberMessage({ threadId, resourceId?, message })` — appends to the working
  buffer and persists `user`/`assistant` turns to Mnemo (`system`/`tool` turns
  stay local only). In `"user"` scope, omitting `resourceId` throws.
- `setThread(thread)` — replace the in-process buffer for a thread (e.g. when
  rehydrating from disk). `thread` is `{ threadId, resourceId?, messages }`.
- `reset()` — clear all in-memory threads (does not delete from Mnemo).
- Per-message metadata (`threadId`, `resourceId`, `role`, `createdAt`) stored
  alongside each memory for filtering and audit.

A `message` is `{ role: "user" | "assistant" | "system" | "tool", content, createdAt? }`.

## Options

| Option           | Default  | Description                                                                          |
| ---------------- | -------- | ------------------------------------------------------------------------------------ |
| `client`         | —        | Existing `Mnemo` instance (overrides `apiKey`/`workspaceId`).                        |
| `apiKey`         | env      | Full-access — keep server-side. Falls back to `GETMNEMO_API_KEY`.                   |
| `workspaceId`    | env      | Falls back to `GETMNEMO_WORKSPACE_ID`.                                               |
| `containerScope` | `"user"` | Isolation boundary: `"user"` (`user:${resourceId}`) or `"thread"` (`thread:${threadId}`). |
| `workingWindow`  | `20`     | Recent messages kept verbatim per thread.                                            |
| `recallLimit`    | `5`      | Default top-k for semantic recall.                                                   |
| `maxThreads`     | `1000`   | Max threads in the in-process LRU buffer before eviction.                            |

## Docs

Full documentation at [mnemohq.com](https://mnemohq.com).

## License

MIT
