// The tab's handle on the agent tools, which run in the world worker. Both the WebMCP adapter
// and the dev panel go through this, so they see exactly what an agent would.

import type { ToolEnvelope, ToolListing } from "@voxyl/tools";
import type { WorldClient } from "../world/WorldClient.ts";
import type { ToolClient } from "./webmcp.ts";

/** Calls and lists tools through the world worker. */
export function workerToolClient(world: Pick<WorldClient, "request">): ToolClient {
  let listing: Promise<ToolListing[]> | null = null;
  return {
    tools() {
      // The list never changes while the page lives: ask once.
      listing ??= world.request({ type: "tools" });
      return listing;
    },
    call(name, args) {
      return world.request({ type: "tool", name, args }) as Promise<ToolEnvelope>;
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
