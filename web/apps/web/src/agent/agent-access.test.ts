import { describe, expect, it } from "vitest";
import { agentRecipes } from "./agent-access.ts";
import { tabUrl } from "./relay-client.ts";

describe("agent recipes", () => {
  const token = "vx1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const recipes = agentRecipes("https://api.voxyl.xyz", token);

  const codeOf = (id: string) =>
    recipes.find((r) => r.id === id)?.steps.find((step) => step.code !== undefined)?.code;

  it("gives Claude Code a command with the header", () => {
    expect(codeOf("claude-code")).toBe(
      `claude mcp add --scope user --transport http voxyl https://api.voxyl.xyz/mcp --header "Authorization: Bearer ${token}"`,
    );
  });

  it("gives Codex a config table", () => {
    expect(codeOf("codex")).toContain('url = "https://api.voxyl.xyz/mcp"');
    expect(codeOf("codex")).toContain(`Bearer ${token}`);
  });

  it("puts the token in the path for ChatGPT, which has no header field", () => {
    expect(codeOf("chatgpt")).toBe(`https://api.voxyl.xyz/mcp/${token}`);
  });

  it("has a tab per agent with steps to follow", () => {
    expect(recipes.map((r) => r.id)).toEqual(["claude-code", "codex", "chatgpt"]);
    for (const recipe of recipes) expect(recipe.steps.length).toBeGreaterThan(1);
  });
});

describe("tabUrl", () => {
  it("turns an http base into the tab socket address", () => {
    expect(tabUrl("https://api.voxyl.xyz")).toBe("wss://api.voxyl.xyz/tab");
    expect(tabUrl("http://127.0.0.1:47826/")).toBe("ws://127.0.0.1:47826/tab");
  });
});
