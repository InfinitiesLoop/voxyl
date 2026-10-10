import { describe, expect, it } from "vitest";
import { agentRecipes } from "./agent-access.ts";
import { tabUrl } from "./relay-client.ts";

describe("agent recipes", () => {
  const token = "vx1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const recipes = agentRecipes("https://api.voxyl.xyz", token);

  it("gives Claude Code a command with the header", () => {
    const claude = recipes.find((r) => r.id === "claude-code");
    expect(claude?.text).toBe(
      `claude mcp add --scope user --transport http voxyl https://api.voxyl.xyz/mcp --header "Authorization: Bearer ${token}"`,
    );
  });

  it("gives Codex a config table", () => {
    const codex = recipes.find((r) => r.id === "codex");
    expect(codex?.text).toContain('url = "https://api.voxyl.xyz/mcp"');
    expect(codex?.text).toContain(`Bearer ${token}`);
  });

  it("puts the token in the path for connectors with no header field", () => {
    expect(recipes.find((r) => r.id === "url")?.text).toBe(`https://api.voxyl.xyz/mcp/${token}`);
  });
});

describe("tabUrl", () => {
  it("turns an http base into the tab socket address", () => {
    expect(tabUrl("https://api.voxyl.xyz")).toBe("wss://api.voxyl.xyz/tab");
    expect(tabUrl("http://127.0.0.1:47826/")).toBe("ws://127.0.0.1:47826/tab");
  });
});
