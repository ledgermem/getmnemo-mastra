#!/usr/bin/env node
/**
 * CI prod smoke gate for `getmnemo-mastra` (the Mastra memory provider).
 *
 * Runs a real round-trip against PRODUCTION through the built `MnemoMemory`
 * wrapper in `./dist`, then asserts the per-`resourceId` tenant-isolation
 * boundary. The publish workflow gates `publish` on `needs: smoke`, so a red
 * run here blocks the release.
 *
 * The CRITICAL path is the memory-store round-trip — `rememberMessage()`
 * (→ core `add`) followed by `remember()` (→ core `search`). It needs NO LLM
 * and is ALWAYS exercised. In the default `containerScope: "user"` mode the
 * durable container is `user:${resourceId}`, so the resourceId IS the
 * isolation boundary: a `remember()` with a different `resourceId` must not see
 * another user's memory.
 *
 * No LLM is involved: the smoke calls MnemoMemory directly, so the publish
 * gate does not depend on any model-provider key or credits. It also asserts
 * that remember() on a never-written resource returns semantic: [] (404
 * "Container not found" tolerance) before the first write.
 *
 * Exit codes:
 *   0  round-trip recalled the memory AND the cross-resourceId isolation
 *      assertion held (no leak).
 *   1  missing required env, round-trip failure, or — loudest of all — a
 *      tenant-isolation leak (a live-server security finding, NOT a flaky test).
 *
 * A leak is a PRODUCTION tenant-isolation security finding (cross-container
 * leakage), not an SDK bug. It outranks the launch — fix the server, do not
 * iterate the SDK around it.
 *
 * Required env:
 *   MNEMO_API_KEY        scoped test key (delete scope used for best-effort cleanup)
 *   MNEMO_WORKSPACE_ID   throwaway test workspace id
 *   MNEMO_TEST_CONTAINER base resource id, e.g. "ci-smoke"
 */

import { Mnemo } from "getmnemo";
import { MnemoMemory } from "../dist/index.js";

const SEARCH_ATTEMPTS = 5;
const SEARCH_RETRY_MS = 2_000;

function fail(msg) {
  console.error(`\n[smoke] FAIL: ${msg}`);
  process.exit(1);
}

/** LOUD failure for a server-side tenant-isolation leak. */
function isolationFailure(detail) {
  const banner = "=".repeat(72);
  console.error(`\n${banner}`);
  console.error("TENANT ISOLATION FAILURE");
  console.error(banner);
  console.error(
    "A recall scoped to one resourceId returned a memory written under a\n" +
      "DIFFERENT resourceId. In containerScope:\"user\" mode the container is\n" +
      "user:${resourceId}, so this is a PRODUCTION tenant-isolation security\n" +
      "finding (cross-container leakage), NOT a flaky test and NOT an SDK bug.\n\n" +
      "This outranks the launch: STOP, fix the server, and do NOT iterate the\n" +
      "SDK around it. Publish is correctly blocked.",
  );
  console.error(`\nDetail: ${detail}`);
  console.error(`${banner}\n`);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True if any semantic hit's content contains `needle`. */
function semanticContains(result, needle) {
  const semantic = result?.semantic;
  if (!Array.isArray(semantic)) return false;
  return semantic.some(
    (hit) => typeof hit?.content === "string" && hit.content.includes(needle),
  );
}

async function main() {
  const apiKey = process.env.MNEMO_API_KEY;
  const workspaceId = process.env.MNEMO_WORKSPACE_ID;
  const base = process.env.MNEMO_TEST_CONTAINER;

  if (!apiKey) fail("MNEMO_API_KEY is not set");
  if (!workspaceId) fail("MNEMO_WORKSPACE_ID is not set");
  if (!base) fail("MNEMO_TEST_CONTAINER is not set");

  // Unique per-run nonce so concurrent / re-run smokes never collide and so a
  // leaked memory from a prior run can't masquerade as this run's data.
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  // Two distinct resourceIds → two distinct user containers. `base` is the
  // resource-id stem (e.g. "ci-smoke"); strip any leading "user:" the caller
  // may have included since MnemoMemory adds the "user:" prefix itself.
  const stem = base.startsWith("user:") ? base.slice("user:".length) : base;
  const resourceId = `ci-${stem}-${nonce}`;
  const otherResourceId = `ci-other-${stem}-${nonce}`;
  const threadId = "t1";
  const secret = `teal-${nonce}`;
  const factContent = `my favorite color is ${secret}`;
  const query = "favorite color";

  // A shared core client lets MnemoMemory write/read while we keep a handle for
  // best-effort cleanup (the wrapper deliberately exposes no delete()).
  const client = new Mnemo({ apiKey, workspaceId });
  const memory = new MnemoMemory({ client, containerScope: "user" });

  console.log("[smoke] run nonce:", nonce);
  console.log("[smoke] resourceId      :", resourceId, "(container user:" + resourceId + ")");
  console.log("[smoke] otherResourceId :", otherResourceId);

  // Track memory ids surfaced by recall so cleanup runs even if assertions throw.
  const createdIds = new Set();

  try {
    // ---- 404 TOLERANCE: recall on a never-written container ------------
    const fresh = await memory.remember({ threadId, resourceId, query });
    if (!Array.isArray(fresh?.semantic) || fresh.semantic.length !== 0) {
      fail(`fresh-container remember() expected semantic: [], got ${JSON.stringify(fresh?.semantic ?? null)}`);
    }
    console.log("[smoke] OK 404 tolerance: fresh-container remember() → semantic: []");

    // ---- CRITICAL PATH: write via rememberMessage (→ core add) ----------
    await memory.rememberMessage({
      threadId,
      resourceId,
      message: { role: "user", content: factContent },
    });

    // Round-trip: the memory MUST come back under its OWN resourceId. Retry
    // briefly to give the indexer time to make the write searchable.
    let own;
    for (let i = 0; i < SEARCH_ATTEMPTS; i++) {
      if (i > 0) await sleep(SEARCH_RETRY_MS);
      own = await memory.remember({ threadId, resourceId, query });
      for (const hit of own?.semantic ?? []) if (hit?.id) createdIds.add(hit.id);
      if (semanticContains(own, secret)) break;
    }

    if (!semanticContains(own, secret)) {
      fail(
        `round-trip failed: remember() for resourceId "${resourceId}" did not ` +
          `return the "${secret}" memory in .semantic. ` +
          `semantic=${JSON.stringify(own?.semantic ?? null)}`,
      );
    }
    console.log("[smoke] OK round-trip: rememberMessage + remember recalled the memory via .semantic");

    // ---- ISOLATION ASSERTION (the security gate) -----------------------
    // The fact was written under `resourceId`; recall under a DIFFERENT
    // resourceId must NOT see it (no cross-user leak).
    const cross = await memory.remember({
      threadId,
      resourceId: otherResourceId,
      query,
    });
    for (const hit of cross?.semantic ?? []) if (hit?.id) createdIds.add(hit.id);

    if (semanticContains(cross, secret)) {
      isolationFailure(
        `"${secret}" (written under resourceId "${resourceId}") leaked into a ` +
          `remember() scoped to resourceId "${otherResourceId}".`,
      );
    }
    console.log(
      "[smoke] OK isolation: resourceId A↛B — the memory did NOT leak across resourceIds",
    );
  } finally {
    // ---- CLEANUP: best-effort delete; failure warns, never fatal -------
    for (const id of createdIds) {
      try {
        await client.delete(id, { containerTag: `user:${resourceId}` });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[smoke] WARN: cleanup delete failed for memory ${id}: ${msg}`);
      }
    }
  }

  console.log("\n[smoke] PASS: round-trip recall + cross-resourceId isolation green.");
  process.exit(0);
}

main().catch((err) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  fail(`unexpected error during smoke run:\n${msg}`);
});
