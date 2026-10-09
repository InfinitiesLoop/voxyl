// The tab's handle on the agent tools, which run in the world worker. Both the WebMCP adapter
// and the dev panel go through this, so they see exactly what an agent would.
//
// A tool can ask the tab for things only the tab can do (open a project, take a picture, move
// the camera): they come back on the reply as `effects`. The client runs them in order, after
// the tool has finished (so the worker is free to serve what they need) and before the call
// resolves, and folds what they return into the envelope.

import type { TabEffect, ToolEnvelope, ToolListing } from "@voxyl/tools";
import type { ToolReply } from "../world/protocol.ts";
import type { WorldClient } from "../world/WorldClient.ts";
import type { ToolClient } from "./webmcp.ts";

/** What the tab does for a tool: one effect at a time; it may return fields for the reply. */
export interface TabActions {
  run(effect: TabEffect): Promise<Record<string, unknown> | undefined>;
}

/** Runs the reply's effects and returns the envelope an agent sees. */
export async function finishReply(
  reply: ToolReply,
  actions: TabActions | undefined,
): Promise<ToolEnvelope> {
  const { effects, ...envelope } = reply;
  if (!effects || effects.length === 0) return envelope as ToolEnvelope;
  const out = envelope as Record<string, unknown>;
  const failures: string[] = [];
  for (const effect of effects) {
    if (!actions) {
      failures.push(`${effect.kind}: this host has no editor to do that in`);
      continue;
    }
    try {
      Object.assign(out, await actions.run(effect));
    } catch (error) {
      failures.push(`${effect.kind}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) out.tab_errors = failures;
  return out as ToolEnvelope;
}

/** Calls and lists tools through the world worker. */
export function workerToolClient(
  world: Pick<WorldClient, "request">,
  actions?: TabActions,
): ToolClient {
  let listing: Promise<ToolListing[]> | null = null;
  return {
    tools() {
      // The list never changes while the page lives: ask once.
      listing ??= world.request({ type: "tools" });
      return listing;
    },
    async call(name, args) {
      return finishReply(await world.request({ type: "tool", name, args }), actions);
    },
  };
}

/** What `window.voxylTools` offers: drive the tools from the console, `pnpm shot` or Playwright. */
export interface VoxylTools {
  list(): Promise<readonly ToolListing[]>;
  call(name: string, args?: unknown): Promise<ToolEnvelope>;
}

/** Puts `window.voxylTools` up for `client`; returns a function that takes it down again. */
export function exposeVoxylTools(client: ToolClient): () => void {
  const api: VoxylTools = { list: () => client.tools(), call: (n, a) => client.call(n, a ?? {}) };
  const holder = window as { voxylTools?: VoxylTools };
  holder.voxylTools = api;
  return () => {
    if (holder.voxylTools === api) delete holder.voxylTools;
  };
}
