// Whether this browser lets agents (Claude Code, Codex, ChatGPT) use the editor, and the token
// they use to find it. Off until the user turns it on: nothing connects to the relay before that.
//
// The token is minted by the relay (stateless; see packages/relay/src/token.ts) and kept in
// this browser. It is the only credential: anyone holding it can drive the open editor.

const KEY = "voxyl.agent";

/** Where the relay lives. A build can point elsewhere with VITE_RELAY_URL. */
export function relayBase(): string {
  const env = (import.meta.env as Record<string, string | undefined>).VITE_RELAY_URL;
  if (env) return env.replace(/\/+$/, "");
  return import.meta.env.DEV ? "http://127.0.0.1:47826" : "https://api.voxyl.xyz";
}

export interface AgentAccess {
  readonly enabled: boolean;
  readonly token: string | null;
}

/** The link between this tab and the relay, for the UI. */
export type RelayState = "off" | "connecting" | "connected" | "retrying";

export interface AgentStatus {
  readonly state: RelayState;
  /** Set when minting a token failed. */
  readonly error: string | null;
}

const OFF: AgentAccess = { enabled: false, token: null };
let access: AgentAccess = read();
let status: AgentStatus = { state: "off", error: null };
const listeners = new Set<() => void>();

function read(): AgentAccess {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<AgentAccess> | null;
    if (parsed && typeof parsed === "object") {
      const token = typeof parsed.token === "string" && parsed.token !== "" ? parsed.token : null;
      return { enabled: parsed.enabled === true && token !== null, token };
    }
  } catch {
    // Unreadable storage means off.
  }
  return OFF;
}

function changed(): void {
  for (const listener of listeners) listener();
}

function write(next: AgentAccess): void {
  access = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Without storage it still works until the tab closes.
  }
  changed();
}

export const subscribeAgentAccess = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const getAgentAccess = (): AgentAccess => access;
export const getAgentStatus = (): AgentStatus => status;

export function setRelayState(state: RelayState): void {
  if (status.state === state && status.error === null) return;
  status = { state, error: null };
  changed();
}

function setError(error: string | null): void {
  status = { ...status, error };
  changed();
}

async function mint(): Promise<string> {
  const response = await fetch(`${relayBase()}/api/token`, { method: "POST" });
  if (!response.ok) throw new Error(`The relay answered ${response.status}.`);
  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token !== "string") throw new Error("The relay sent no token.");
  return body.token;
}

/** Turns agent access on, getting a token first if this browser has none. */
export async function enableAgentAccess(): Promise<void> {
  setError(null);
  try {
    write({ enabled: true, token: access.token ?? (await mint()) });
  } catch (error) {
    setError(
      `Could not reach ${relayBase()}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Disconnects. The token is kept, so turning it back on needs no new setup in the agent. */
export function disableAgentAccess(): void {
  write({ enabled: false, token: access.token });
}

/**
 * A new token. Agents set up with the old one stop reaching this editor, which is how to cut
 * one off. Stays on if it was on.
 */
export async function rotateAgentToken(): Promise<void> {
  setError(null);
  try {
    write({ enabled: access.enabled, token: await mint() });
  } catch (error) {
    setError(
      `Could not reach ${relayBase()}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** What to paste into each agent. Pure, so it is tested. */
export interface Recipe {
  readonly id: "claude-code" | "codex" | "url";
  readonly title: string;
  readonly steps: string;
  readonly text: string;
}

export function agentRecipes(base: string, token: string): Recipe[] {
  const url = `${base}/mcp`;
  return [
    {
      id: "claude-code",
      title: "Claude Code",
      steps: "Run this once in a terminal. Then start Claude Code and ask it to build something.",
      text: `claude mcp add --scope user --transport http voxyl ${url} --header "Authorization: Bearer ${token}"`,
    },
    {
      id: "codex",
      title: "Codex",
      steps: "Add this to ~/.codex/config.toml, then restart Codex.",
      text: `[mcp_servers.voxyl]\nurl = "${url}"\nhttp_headers = { Authorization = "Bearer ${token}" }`,
    },
    {
      id: "url",
      title: "ChatGPT and others",
      steps:
        "For a connector with no header field, paste this address with no authentication. " +
        "The address itself is the password.",
      text: `${url}/${token}`,
    },
  ];
}
