import { describe, expect, it } from "vitest";
import { noteTarget, parseNote } from "./note.ts";

describe("opening notes", () => {
  it("reads paragraphs and voxyl links, and leaves other links as text", () => {
    const note = parseNote(
      "Bring a jar.\n\n[Import a Minecraft jar](blocks) then [a city](sample:city-1m). See [the web](https://example.com).",
    );
    expect(note).toEqual([
      [{ kind: "text", text: "Bring a jar." }],
      [
        {
          kind: "link",
          label: "Import a Minecraft jar",
          href: "blocks",
          target: { tab: "blocks" },
        },
        { kind: "text", text: " then " },
        {
          kind: "link",
          label: "a city",
          href: "sample:city-1m",
          target: { sample: "city-1m" },
        },
        { kind: "text", text: ". See [the web](https://example.com)." },
      ],
    ]);
  });

  it("names the home tabs and the samples", () => {
    expect(noteTarget("builds")).toEqual({ tab: "projects" });
    expect(noteTarget("sample:nope")).toBeNull();
    expect(noteTarget("sample:mc-blocks")).toEqual({ sample: "mc-blocks" });
  });
});
