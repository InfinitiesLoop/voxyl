// The relay's brain, free of Cloudflare: which tab answers a call, what is waiting for an
// answer, and the cached tool list. The Durable Object is a thin shell over this (it owns the
// sockets and storage), so the routing rules are tested in Node with fake sockets.
//
// One relay serves one agent token. Several tabs may be open on it. A call goes to the tab the
// user used last, so "the open editor" means the one they are looking at.

import { type McpBackend, RelayError } from "./mcp.ts";
import { type McpToolResult, parseTabMessage, type RelayToTab, type ToolSpec } from "./protocol.ts";

// Timers exist in every host this runs in; this package carries no DOM or Node types.
declare function setTimeout(handler: () => void, ms: number): unknown;
declare function clearTimeout(id: unknown): void;

/** A way to push text to one tab (a WebSocket, in production). */
export interface TabLink {
  send(text: string): void;
}

/** Where the tool list outlives the process, so it is served while no tab is open. */
export interface ToolStore {
  load(): Promise<readonly ToolSpec[] | null>;
  save(tools: readonly ToolSpec[]): Promise<void>;
}

export interface RelayOptions {
  readonly store: ToolStore;
  readonly now?: () => number;
  readonly newId?: () => string;
  /** How long a call may wait for its tab. Default 90 s. */
  readonly timeoutMs?: number;
  /** Calls in flight at once. Default 16. */
  readonly maxPending?: number;
  /** Tabs held at once; the least recently used are dropped. Default 8. */
  readonly maxTabs?: number;
}

interface Tab {
  readonly link: TabLink;
  lastActive: number;
  /** Attach order, to break ties between tabs with the same stamp. */
  readonly order: number;
}

interface Pending {
  readonly tabId: string;
  resolve(result: McpToolResult): void;
  reject(error: Error): void;
  readonly timer: unknown;
}

export const NO_TAB_MESSAGE =
  "No Voxyl editor is open for this connection. Open https://voxyl.xyz in a browser, go to " +
  "Home > Agents, and make sure agent access is on. Then call this again.";

export const INSTRUCTIONS =
  "Voxyl is a voxel design tool. These tools run in the user's open editor tab, so every " +
  "edit shows up live and is one undo step. Call status first, then guide for the conventions. " +
  "Cells hold semantic names, never materials. If the user has several tabs open, the one they " +
  "used last answers. If no tab is open, calls fail until they open voxyl.xyz.";

export class RelayCore implements McpBackend {
  readonly instructions = INSTRUCTIONS;
  private readonly tabs = new Map<string, Tab>();
  private readonly pending = new Map<string, Pending>();
  private attached = 0;
  private cached: readonly ToolSpec[] | null = null;
  private cachedJson = "";
  private readonly store: ToolStore;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly timeoutMs: number;
  private readonly maxPending: number;
  private readonly maxTabs: number;

  constructor(options: RelayOptions) {
    let counter = 0;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => `c${++counter}`);
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.maxPending = options.maxPending ?? 16;
    this.maxTabs = options.maxTabs ?? 8;
  }

  /** How many tabs are attached. */
  get tabCount(): number {
    return this.tabs.size;
  }

  /** The tab calls would go to now, or null. */
  get activeTab(): string | null {
    let best: [string, Tab] | null = null;
    for (const entry of this.tabs) {
      const tab = entry[1];
      if (
        !best ||
        tab.lastActive > best[1].lastActive ||
        (tab.lastActive === best[1].lastActive && tab.order > best[1].order)
      )
        best = entry;
    }
    return best ? best[0] : null;
  }

  /**
   * A tab is here: it just connected, or the object woke and found its socket. Returns the tab
   * ids to drop to stay within the limit.
   */
  attach(tabId: string, link: TabLink, lastActive = this.now()): string[] {
    this.tabs.set(tabId, { link, lastActive, order: this.attached++ });
    const dropped: string[] = [];
    while (this.tabs.size - dropped.length > this.maxTabs) {
      let oldest: [string, Tab] | null = null;
      for (const entry of this.tabs) {
        if (dropped.includes(entry[0]) || entry[0] === tabId) continue;
        if (!oldest || entry[1].lastActive < oldest[1].lastActive) oldest = entry;
      }
      if (!oldest) break;
      dropped.push(oldest[0]);
    }
    return dropped;
  }

  /** The tab's socket closed. Whatever it still owed is failed at once. */
  detach(tabId: string): void {
    this.tabs.delete(tabId);
    for (const [id, pending] of this.pending) {
      if (pending.tabId !== tabId) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(
        new RelayError(
          "tab_closed",
          "The editor tab closed before it answered. The call may or may not have run: " +
            "check with status before repeating an edit.",
        ),
      );
    }
  }

  /** Marks a tab as the one in use. Returns the stamp (to persist), or null for an unknown tab. */
  touch(tabId: string): number | null {
    const tab = this.tabs.get(tabId);
    if (!tab) return null;
    tab.lastActive = this.now();
    return tab.lastActive;
  }

  /** A text frame from a tab. Returns the new activity stamp when the tab became the active one. */
  async onMessage(tabId: string, text: string): Promise<{ active?: number }> {
    const message = parseTabMessage(text);
    if (!message) return {};
    switch (message.type) {
      case "hello": {
        const stamp = this.touch(tabId);
        await this.remember(message.tools);
        return stamp === null ? {} : { active: stamp };
      }
      case "active": {
        const stamp = this.touch(tabId);
        return stamp === null ? {} : { active: stamp };
      }
      case "result": {
        const pending = this.pending.get(message.id);
        // Only the tab that was asked may answer.
        if (!pending || pending.tabId !== tabId) return {};
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        pending.resolve(message.result);
        return {};
      }
    }
  }

  /** Caches the tool list a tab sent, and stores it unless storage already holds the same. */
  private async remember(tools: readonly ToolSpec[]): Promise<void> {
    const json = JSON.stringify(tools);
    if (json === this.cachedJson) return;
    this.cached = tools;
    this.cachedJson = json;
    const stored = await this.store.load();
    if (stored && JSON.stringify(stored) === json) return;
    await this.store.save(tools);
  }

  async tools(): Promise<readonly ToolSpec[]> {
    if (this.cached) return this.cached;
    const stored = await this.store.load();
    if (!stored) return [];
    this.cached = stored;
    this.cachedJson = JSON.stringify(stored);
    return stored;
  }

  call(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const tabId = this.activeTab;
    const tab = tabId === null ? undefined : this.tabs.get(tabId);
    if (tabId === null || !tab) return Promise.reject(new RelayError("no_editor", NO_TAB_MESSAGE));
    if (this.pending.size >= this.maxPending) {
      return Promise.reject(
        new RelayError("busy", "Too many calls are waiting for the editor. Try again shortly."),
      );
    }
    const id = this.newId();
    const frame: RelayToTab = { type: "call", id, name, args };
    return new Promise<McpToolResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new RelayError(
            "editor_timeout",
            `The editor did not answer within ${Math.round(this.timeoutMs / 1000)} s. ` +
              "The tab may be frozen or asleep, and the call may still run.",
          ),
        );
      }, this.timeoutMs);
      this.pending.set(id, { tabId, resolve, reject, timer });
      try {
        tab.link.send(JSON.stringify(frame));
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        this.tabs.delete(tabId);
        reject(new RelayError("tab_gone", "The editor tab went away. Open voxyl.xyz again."));
      }
    });
  }
}
