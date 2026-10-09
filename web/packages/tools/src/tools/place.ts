import type { CellStateArg, SemanticArg } from "@voxyl/core";
import { rejectPart } from "@voxyl/shapes";
import { z } from "zod";
import { CellFields, type CellFieldValues, type PartPlan, planCell, type Tags } from "../cell.ts";
import { resolveSemantic, type SemanticTarget, SemRef } from "../names.ts";
import { PosSchema } from "../region.ts";
import { editResult, MutatingFields, type Rejection } from "../result.ts";
import { defineTool, ToolError } from "../tool.ts";

const MAX_CELLS = 5000;
const MAX_POSITIONS = 20_000;

const CellSpec = z.strictObject({ at: PosSchema, semantic: SemRef, ...CellFields });

/** A semantic as the part rules compare it: an id, or a stand-in for one not derived yet. */
const ruleKey = (s: SemanticArg) => (typeof s === "number" ? s : `${s.palette}:${s.base}`);

interface Pending {
  parts: PartPlan[];
  rotation: number | undefined;
  tags: Tags | undefined;
}

export const place = defineTool({
  name: "place",
  title: "Place cells",
  description:
    "Place semantics at explicit positions. `cells`: [{at:[x,y,z], semantic, facing?, up?, slot?}] " +
    "for cells that differ, or `at`: [[x,y,z],...] with one `semantic` for many cells that match. " +
    "A whole-block semantic replaces whatever is in the cell. A shaped semantic (its palette " +
    "entry has a shape) adds a part in `slot` and keeps the cell's other parts; parts that " +
    "can't share a cell, or a part into a whole block, are listed in `rejected`. For big areas " +
    "use fill; this is for scattered or oriented cells.",
  input: z.strictObject({
    cells: z.array(CellSpec).min(1).max(MAX_CELLS).optional(),
    at: z.array(PosSchema).min(1).max(MAX_POSITIONS).optional(),
    semantic: SemRef.optional().describe("With `at`: the semantic every position gets."),
    ...CellFields,
    ...MutatingFields,
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  async handler(_host, args, call) {
    const project = call.project;
    const world = project.world;
    const { cells, at, semantic, op_id: _op, dry_run: _dry, ...shared } = args;
    if ((cells === undefined) === (at === undefined)) {
      throw new ToolError("bad_argument", "Give either `cells` or `at` with `semantic`, not both.");
    }
    if (at !== undefined && semantic === undefined) {
      throw new ToolError("bad_argument", "`at` needs a `semantic` to place.");
    }
    const entries: { at: readonly [number, number, number]; ref: SemRef; spec: CellFieldValues }[] =
      cells !== undefined
        ? cells.map(({ at: pos, semantic: ref, ...spec }) => ({ at: pos, ref, spec }))
        : (at ?? []).map((pos) => ({ at: pos, ref: semantic as SemRef, spec: shared }));

    const targets = new Map<string, SemanticTarget>();
    const targetOf = (ref: SemRef) => {
      const key = JSON.stringify(ref);
      let t = targets.get(key);
      if (!t) {
        t = resolveSemantic(project, ref);
        targets.set(key, t);
      }
      return t;
    };

    const rejected: Rejection[] = [];
    const ignored = new Set<string>();
    // The state each touched cell ends up in, so several placements into one cell add up.
    const blocks = new Map<string, CellStateArg>();
    const parts = new Map<string, Pending>();
    let placed = 0;

    for (const { at: pos, ref, spec } of entries) {
      const [x, y, z] = pos;
      const reject = (reason: string, detail?: string) =>
        rejected.push({ at: pos, reason, ...(detail !== undefined && { detail }) });
      if (![x, y, z].every((v) => world.layout.isWorldCoord(v))) {
        reject("out_of_world");
        continue;
      }
      const plan = planCell(targetOf(ref), spec, ignored);
      const k = pos.join(",");
      if (plan.kind === "reject") {
        reject(plan.reason, plan.detail);
        continue;
      }
      if (plan.kind === "block") {
        parts.delete(k);
        blocks.set(k, plan.state);
        placed++;
        continue;
      }
      // A part joins what the cell already holds.
      let cell = parts.get(k);
      if (!cell) {
        if (blocks.has(k)) {
          reject("block_in_cell", "This call placed a whole block here.");
          continue;
        }
        const existing = world.get(x, y, z);
        if (existing && existing.parts.length === 0) {
          reject("block_in_cell", "The cell holds a whole block; clear it first.");
          continue;
        }
        cell = {
          parts: (existing?.parts ?? []).map((p) => ({
            semantic: p.semantic,
            shape: p.shape,
            slot: p.slot,
          })),
          rotation: existing?.rotation,
          tags:
            existing && Object.keys(existing.tags).length > 0 ? { ...existing.tags } : undefined,
        };
      }
      const part = plan.part;
      const same = cell.parts.some(
        (p) =>
          ruleKey(p.semantic) === ruleKey(part.semantic) &&
          p.shape === part.shape &&
          p.slot === part.slot,
      );
      if (!same) {
        const why = rejectPart(
          cell.parts.map((p) => ({ semantic: ruleKey(p.semantic), shape: p.shape, slot: p.slot })),
          { semantic: ruleKey(part.semantic), shape: part.shape, slot: part.slot },
        );
        if (why) {
          reject(why);
          continue;
        }
        cell.parts.push(part);
      }
      if (plan.tags) cell.tags = { ...cell.tags, ...plan.tags };
      parts.set(k, cell);
      placed++;
    }

    // One `set`: the distinct states once, and the cells as [x, y, z, stateIndex].
    const stateList: CellStateArg[] = [];
    const indexOf = new Map<string, number>();
    const flat: number[] = [];
    const add = (k: string, state: CellStateArg) => {
      const id = JSON.stringify(state);
      let index = indexOf.get(id);
      if (index === undefined) {
        index = stateList.push(state) - 1;
        indexOf.set(id, index);
      }
      const [x = 0, y = 0, z = 0] = k.split(",").map(Number);
      flat.push(x, y, z, index);
    };
    for (const [k, state] of blocks) add(k, state);
    for (const [k, cell] of parts) {
      add(k, {
        parts: cell.parts,
        ...(cell.rotation !== undefined && cell.rotation !== 0 && { rotation: cell.rotation }),
        ...(cell.tags !== undefined && { tags: cell.tags }),
      });
    }
    const summary =
      flat.length > 0
        ? await call.run([{ kind: "set", args: { states: stateList, cells: flat } }])
        : null;
    return editResult(summary, { placed, rejected, problems: [...ignored] });
  },
});
