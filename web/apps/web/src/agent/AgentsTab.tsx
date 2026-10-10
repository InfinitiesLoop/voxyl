import { useState, useSyncExternalStore } from "react";
import {
  agentRecipes,
  disableAgentAccess,
  enableAgentAccess,
  getAgentAccess,
  getAgentStatus,
  type RelayState,
  relayBase,
  rotateAgentToken,
  subscribeAgentAccess,
} from "./agent-access.ts";

const STATE_TEXT: Record<RelayState, string> = {
  off: "Off. No agent can reach this editor.",
  connecting: "Connecting to the relay...",
  connected: "On. Agents can use this editor while this tab is open.",
  retrying: "Can't reach the relay. Trying again...",
};

/** Hides the token in what is shown; Copy still takes the whole text. */
function masked(text: string, token: string): string {
  return text.split(token).join("vx1.••••••••");
}

/**
 * Home, Agents: lets an AI agent drive the open editor. Off until turned on. The agent talks to
 * the relay (api.voxyl.xyz); the relay forwards each call to this tab, which runs it.
 */
export function AgentsTab() {
  const access = useSyncExternalStore(subscribeAgentAccess, getAgentAccess);
  const status = useSyncExternalStore(subscribeAgentAccess, getAgentStatus);
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const base = relayBase();

  const copy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      window.setTimeout(() => setCopied((now) => (now === id ? null : now)), 1500);
    } catch {
      setCopied(null);
    }
  };

  return (
    <section className="home-section agents">
      <h2>Agents</h2>
      <p className="home-quiet">
        Let an AI agent such as Claude Code, Codex or ChatGPT build in your open editor. Its edits
        show up live, and each one is an undo step. The tools run in this browser tab, so keep Voxyl
        open while an agent works. The relay only passes messages between the agent and this tab: it
        does not keep your builds.
      </p>
      <div className="home-actions">
        {access.enabled ? (
          <button type="button" onClick={disableAgentAccess}>
            Turn off
          </button>
        ) : (
          <button type="button" className="primary" onClick={() => void enableAgentAccess()}>
            Let agents use this editor
          </button>
        )}
        <span
          className={`agents-state agents-${access.enabled ? status.state : "off"}`}
          role="status"
        >
          {STATE_TEXT[access.enabled ? status.state : "off"]}
        </span>
      </div>
      {status.error !== null && <p className="agents-error">{status.error}</p>}

      {access.enabled && access.token !== null && (
        <>
          {agentRecipes(base, access.token).map((recipe) => (
            <div key={recipe.id} className="agents-recipe">
              <h3>{recipe.title}</h3>
              <p className="home-quiet">{recipe.steps}</p>
              <pre>{reveal ? recipe.text : masked(recipe.text, access.token as string)}</pre>
              <button type="button" onClick={() => void copy(recipe.id, recipe.text)}>
                {copied === recipe.id ? "Copied" : "Copy"}
              </button>
            </div>
          ))}
          <div className="home-actions">
            <button type="button" onClick={() => setReveal(!reveal)}>
              {reveal ? "Hide token" : "Show token"}
            </button>
            <button
              type="button"
              title="Agents set up with the old token stop reaching this editor"
              onClick={() => {
                if (confirm("Make a new token? Agents set up with the old one stop working."))
                  void rotateAgentToken();
              }}
            >
              New token
            </button>
          </div>
          <p className="home-quiet">
            The token is a password: anyone who has it can edit whatever is open here. If you have
            several Voxyl tabs open, the one you used last answers.
          </p>
        </>
      )}
    </section>
  );
}
