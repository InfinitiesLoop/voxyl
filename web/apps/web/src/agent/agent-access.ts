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

/** One step of an agent's setup: what to do, and optionally the text to copy for it. */
export interface Step {
  readonly say: string;
  readonly code?: string;
}

/** What to do in each agent. Pure, so it is tested. */
export interface Recipe {
  readonly id: "claude-code" | "codex" | "chatgpt";
  readonly title: string;
  readonly intro: string;
  readonly steps: readonly Step[];
  readonly notes: readonly string[];
}

export function agentRecipes(base: string, token: string): Recipe[] {
  const url = `${base}/mcp`;
  return [
    {
      id: "claude-code",
      title: "Claude Code",
      intro:
        "Claude's coding agent, in a terminal. It reaches Voxyl with a header carrying the token.",
      steps: [
        {
          say: "Run this once in a terminal. It saves Voxyl as a tool for every project.",
          code: `claude mcp add --scope user --transport http voxyl ${url} --header "Authorization: Bearer ${token}"`,
        },
        { say: "Start Claude Code (or restart it if it was already running)." },
        { say: "Keep Voxyl open in a browser tab, then ask it to build something." },
      ],
      notes: ["Run /mcp inside Claude Code to check that voxyl shows as connected."],
    },
    {
      id: "codex",
      title: "Codex",
      intro:
        "OpenAI's coding agent. It is included with every ChatGPT plan and signs in with your " +
        "ChatGPT account. The terminal app, the IDE extension and the desktop app's Codex mode " +
        "all read the same config file.",
      steps: [
        {
          say: "Open ~/.codex/config.toml (the .codex folder in your user folder, also on Windows) and add this.",
          code: `[mcp_servers.voxyl]
url = "${url}"
http_headers = { Authorization = "Bearer ${token}" }`,
        },
        { say: "Restart Codex so it reads the file." },
        { say: "Keep Voxyl open in a browser tab, then ask Codex to build something." },
      ],
      notes: [],
    },
    {
      id: "chatgpt",
      title: "ChatGPT",
      intro:
        "The ChatGPT website works as a chat client: add Voxyl once as a custom connector, then " +
        "ask ChatGPT to build while this tab is open. ChatGPT's connector form has no field for a " +
        "token, so the token is part of the address instead. That makes the address a password.",
      steps: [
        {
          say: "Copy this address. It is only for your ChatGPT.",
          code: `${url}/${token}`,
        },
        {
          say:
            "In ChatGPT on the web, open chatgpt.com/plugins and choose + then Create custom MCP " +
            "server. If you don't see it, turn on Developer mode first (Settings, Apps, Advanced " +
            "settings).",
        },
        {
          say:
            "Name it Voxyl, paste the address as the server URL, and set Authentication to " +
            "None. There is nothing else to sign in to: the token in the address is the login.",
        },
        { say: "Save it, and accept the notice that this is a connector you added yourself." },
        {
          say:
            "Keep Voxyl open here, with the switch above on. Start a new chat in ChatGPT, add " +
            "Voxyl with + or by typing @Voxyl, and ask it to build something.",
        },
      ],
      notes: [
        "Custom connectors need a ChatGPT plan that allows them (Plus, Pro, or a workspace plan " +
          "with developer mode turned on by an admin). On a free account, use Codex instead.",
        "ChatGPT's model only sees what the tools return, so a small first request works best: " +
          "ask it to call status and the guide tool first, then describe the build.",
        "If you make a new token, the old address stops working: edit the connector in ChatGPT " +
          "and paste the new one.",
      ],
    },
  ];
}
