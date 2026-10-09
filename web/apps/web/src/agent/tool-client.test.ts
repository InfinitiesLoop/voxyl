import type { TabEffect } from "@voxyl/tools";
import { describe, expect, it, vi } from "vitest";
import type { ToolReply } from "../world/protocol.ts";
import { finishReply, workerToolClient } from "./tool-client.ts";

describe("finishReply", () => {
  it("returns a reply without effects as it is", async () => {
    expect(await finishReply({ ok: true, cells: 2 }, undefined)).toEqual({ ok: true, cells: 2 });
  });

  it("runs effects in order, merges what they return and drops the effects field", async () => {
    const ran: string[] = [];
    const actions = {
      run: vi.fn(async (e: TabEffect) => {
        ran.push(e.kind);
        return e.kind === "open_project" ? { opened_in_editor: true } : undefined;
      }),
    };
    const reply: ToolReply = {
      ok: true,
      opened: "Tower",
      effects: [
        { kind: "open_project", id: "a" },
        { kind: "project_saved", id: "a" },
      ],
    };
    expect(await finishReply(reply, actions)).toEqual({
      ok: true,
      opened: "Tower",
      opened_in_editor: true,
    });
    expect(ran).toEqual(["open_project", "project_saved"]);
  });

  it("reports an effect that failed, or that has nobody to run it, without losing the reply", async () => {
    const reply: ToolReply = { ok: true, effects: [{ kind: "open_project", id: "a" }] };
    const failing = await finishReply(reply, {
      run: async () => {
        throw new Error("renderer is gone");
      },
    });
    expect(failing).toMatchObject({ ok: true, tab_errors: ["open_project: renderer is gone"] });
    const nobody = await finishReply(reply, undefined);
    expect((nobody as unknown as { tab_errors: string[] }).tab_errors[0]).toContain("no editor");
  });

  it("the worker client sends the call and finishes the reply", async () => {
    const reply: ToolReply = { ok: true, effects: [{ kind: "project_saved", id: "p" }] };
    const request = vi.fn(async () => reply);
    const run = vi.fn(async () => ({ extra: 1 }));
    const client = workerToolClient({ request } as never, { run });
    expect(await client.call("project_save", {})).toEqual({ ok: true, extra: 1 });
    expect(request).toHaveBeenCalledWith({ type: "tool", name: "project_save", args: {} });
  });
});
