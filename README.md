# getmnemo-mastra

[Mnemo](https://mnemohq.com)-backed memory provider for [Mastra](https://mastra.ai) agents.
Combines a per-thread short-term buffer with semantic long-term recall.

## Install

```bash
npm install getmnemo-mastra @mastra/core
```

`getmnemo` (the core SDK) is bundled as a dependency, so it is installed for you.

Set `GETMNEMO_API_KEY` and `GETMNEMO_WORKSPACE_ID`, or pass them in explicitly.

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
// or pass { apiKey, workspaceId } explicitly.
const memory = new MnemoMemory({ workingWindow: 20, recallLimit: 5 });

const agent = new Agent({
  name: "support",
  instructions: "Use long-term memory to personalize responses.",
  model: openai("gpt-4o"),
});

const threadId = "user-42";
const resourceId = "user-42";

// 1. Persist the incoming user turn.
const userMessage = "Remember that I prefer concise answers.";
await memory.rememberMessage({
  threadId,
  resourceId,
  message: { role: "user", content: userMessage },
});

// 2. Recall recent + semantic context for this turn.
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
  `query` is provided; results are filtered to the requested
  `threadId`/`resourceId` to prevent cross-thread context bleed.
- `rememberMessage({ threadId, resourceId?, message })` — appends to the working
  buffer and persists `user`/`assistant` turns to Mnemo (`system`/`tool` turns
  stay local only).
- `setThread(thread)` — replace the in-process buffer for a thread (e.g. when
  rehydrating from disk).
- `reset()` — clear all in-memory threads (does not delete from Mnemo).
- Per-message metadata (`threadId`, `resourceId`, `role`, `createdAt`) stored
  alongside each memory for filtering and audit.

## Options

| Option          | Default | Description                                                         |
| --------------- | ------- | ------------------------------------------------------------------- |
| `client`        | —       | Existing `Mnemo` instance (overrides `apiKey`/`workspaceId`).       |
| `apiKey`        | env     | Falls back to `GETMNEMO_API_KEY`.                                   |
| `workspaceId`   | env     | Falls back to `GETMNEMO_WORKSPACE_ID`.                              |
| `workingWindow` | `20`    | Recent messages kept verbatim per thread.                           |
| `recallLimit`   | `5`     | Default top-k for semantic recall.                                  |
| `maxThreads`    | `1000`  | Max threads in the in-process LRU buffer before eviction.           |

## Docs

Full documentation at [mnemohq.com](https://mnemohq.com).

## License

MIT
