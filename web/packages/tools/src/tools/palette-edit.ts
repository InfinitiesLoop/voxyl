import { parseBlockRef } from "@voxyl/blocks";
import {
  CommandError,
  type Form,
  type Look,
  PLACEMENTS,
  type Project,
  type SemanticArg,
} from "@voxyl/core";
import { isKnownShape } from "@voxyl/shapes";
import { z } from "zod";
import { resolvePalette, resolveSemantic } from "../names.ts";
import { describePalette, usage } from "../palettes.ts";
import { editResult, MutatingFields } from "../result.ts";
import { type CommandSpec, defineTool, ToolError, type ToolHost } from "../tool.ts";

const MAX_OPS = 200;
const Name = z.string().trim().min(1).max(80);

const Op = z.strictObject({
  op: z.enum(["add", "set", "rename", "remove"]),
  semantic: Name.describe("The semantic this op is about."),
  to: Name.optional().describe("rename: the new name. Cells keep their semantic."),
  block: z
    .string()
    .regex(/^[\w.-]+:[\w./-]+$/, "a qualified block reference, library:block")
    .nullable()
    .optional()
    .describe("add/set: the block it looks like, library:block (null clears: undecided)."),
  shape: z
    .string()
    .nullable()
    .optional()
    .describe(
      "add/set: the part shape it places (edge1, face4, roof_tile...); null = whole blocks.",
    ),
  placement: z
    .enum(Object.keys(PLACEMENTS) as [keyof typeof PLACEMENTS, ...(keyof typeof PLACEMENTS)[]])
    .nullable()
    .optional()
    .describe(
      "add/set: how whole blocks of it may be turned (torch = hangs on a wall or floor, stairs, slab, log, horizontal, facing, hopper, cube); null clears.",
    ),
  glow: z.boolean().nullable().optional().describe("add/set: whether it emits light."),
  tint: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i, "a colour, #rrggbb")
    .nullable()
    .optional()
    .describe("add/set: a hint colour for an undecided semantic."),
  description: z.string().nullable().optional(),
});

export const paletteEdit = defineTool({
  name: "palette_edit",
  title: "Edit a palette",
  description:
    "Create a palette and edit its semantics in one call. `create` makes the palette if it " +
    "doesn't exist (optionally extending another, whose semantics it can override). `ops` run " +
    "in order: add (name + optional block, shape, glow), set (change those on an existing or " +
    "inherited semantic; setting an inherited one overrides it in this palette only), rename " +
    "(cells follow), remove (refused while cells use it). Cells hold semantics, so changing " +
    "a block here re-skins every cell without touching the build. A semantic with no block is " +
    "undecided. Use this to make semantics before placing them.",
  input: z.strictObject({
    palette: Name.describe("The palette to edit, by name. The first palette is 'Main'."),
    create: z
      .union([
        z.boolean(),
        z.strictObject({
          description: z.string().optional(),
          extends: Name.optional().describe("A palette this one builds on."),
        }),
      ])
      .optional()
      .describe("Create the palette if it doesn't exist."),
    palette_set: z
      .strictObject({
        name: Name.optional(),
        description: z.string().nullable().optional(),
        extends: Name.nullable().optional(),
      })
      .optional()
      .describe("Rename, describe or re-parent the palette itself."),
    ops: z.array(Op).max(MAX_OPS).optional(),
    delete: z
      .boolean()
      .optional()
      .describe("Remove the palette and its semantics (refused while cells use them)."),
    ...MutatingFields,
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  async handler(host, args, call) {
    const project = call.project;
    // Ids of new palettes come from the commands, so the plan runs on a scratch fork that later
    // commands read their ids from. The same specs then run for real (or as the dry run).
    const scratch = project.fork();
    const specs: CommandSpec[] = [];
    const plan = (spec: CommandSpec, what: string) => {
      try {
        const result = scratch.run({ id: `plan-${specs.length}`, ...spec });
        specs.push(spec);
        return result;
      } catch (error) {
        if (error instanceof CommandError) {
          throw new ToolError("command_failed", `${what}: ${error.message}`);
        }
        throw error;
      }
    };
    const check = <T>(what: string, f: () => T): T => {
      try {
        return f();
      } catch (error) {
        if (error instanceof ToolError)
          throw new ToolError(error.code, `${what}: ${error.message}`, error.details);
        throw error;
      }
    };

    let found = true;
    try {
      resolvePalette(scratch, args.palette);
    } catch (error) {
      if (!(error instanceof ToolError) || error.code !== "not_found") throw error;
      found = false;
    }
    if (!found) {
      if (args.create === undefined || args.create === false) {
        throw check("palette", () => resolvePalette(scratch, args.palette));
      }
      const options = args.create === true ? {} : args.create;
      plan(
        {
          kind: "palette_add",
          args: {
            name: args.palette,
            ...(options.description !== undefined && { description: options.description }),
            ...(options.extends !== undefined && {
              extends: check("create.extends", () =>
                resolvePalette(scratch, options.extends ?? ""),
              ),
            }),
          },
        },
        `create ${args.palette}`,
      );
    }
    const paletteId = resolvePalette(scratch, args.palette);

    if (args.palette_set) {
      const { name, description, extends: parent } = args.palette_set;
      plan(
        {
          kind: "palette_update",
          args: {
            palette: paletteId,
            ...(name !== undefined && { name }),
            ...(description !== undefined && { description }),
            ...(parent !== undefined && {
              extends:
                parent === null
                  ? null
                  : check("palette_set.extends", () => resolvePalette(scratch, parent)),
            }),
          },
        },
        "palette_set",
      );
    }

    const ops = args.ops ?? [];
    ops.forEach((op, i) => {
      const what = `ops[${i}] ${op.op} ${op.semantic}`;
      const paletteName = scratch.semantics.palette(paletteId).name;
      if (op.shape != null && !isKnownShape(op.shape)) {
        throw new ToolError("bad_argument", `${what}: unknown shape "${op.shape}".`, {
          op_index: i,
        });
      }
      if (op.op !== "rename" && op.to !== undefined) {
        throw new ToolError("bad_argument", `${what}: \`to\` is only for rename.`, { op_index: i });
      }
      if (op.op === "add") {
        plan(
          {
            kind: "semantic_add",
            args: {
              name: op.semantic,
              palette: paletteId,
              ...(op.description != null && { description: op.description }),
              ...((op.shape != null || op.placement != null) && {
                form: {
                  ...(op.shape != null && { shape: op.shape }),
                  ...(op.placement != null && { placement: PLACEMENTS[op.placement] }),
                },
              }),
              ...lookOf({}, op, true),
            },
          },
          what,
        );
        return;
      }
      const target = check(what, () =>
        resolveSemantic(scratch, { name: op.semantic, palette: paletteName }),
      );
      if (op.op === "rename") {
        if (op.to === undefined) {
          throw new ToolError("bad_argument", `${what}: rename needs \`to\`.`, { op_index: i });
        }
        plan({ kind: "semantic_update", args: { semantic: target.arg, name: op.to } }, what);
      } else if (op.op === "remove") {
        if (typeof target.arg !== "number") {
          throw new ToolError(
            "bad_argument",
            `${what}: ${op.semantic} is inherited and not yet used here; nothing to remove.`,
            { op_index: i },
          );
        }
        plan({ kind: "semantic_remove", args: { semantic: target.arg } }, what);
      } else {
        const own = ownOf(scratch, target.arg);
        const form = formOf(own.form, op);
        plan(
          {
            kind: "semantic_update",
            args: {
              semantic: target.arg,
              ...(op.description !== undefined && { description: op.description }),
              ...(form !== undefined && { form }),
              ...lookOf(own.look ?? {}, op, false),
            },
          },
          what,
        );
      }
    });

    if (args.delete === true) {
      plan({ kind: "palette_remove", args: { palette: paletteId } }, `delete ${args.palette}`);
    }

    const problems = await unknownBlocks(host, ops);
    const summary = specs.length > 0 ? await call.run(specs) : null;
    const after = summary?.after ?? project;
    const final = args.delete === true ? null : after.semantics.palette(paletteId);
    return editResult(summary, {
      ...(final && { palette: describePalette(after, paletteId, usage(after)) }),
      ...(args.delete === true && { deleted: args.palette }),
      ops_applied: specs.length,
      problems,
    });
  },
});

/** The semantic's own form and look (what it sets itself, not what it inherits). */
function ownOf(project: Project, ref: SemanticArg): { form?: Form; look?: Look } {
  if (typeof ref !== "number") return {};
  const s = project.semantics.get(ref);
  return {
    ...(s.form !== undefined && { form: s.form }),
    ...(s.look !== undefined && { look: s.look }),
  };
}

type Edit = z.output<typeof Op>;

/**
 * The look argument for an op: the semantic's own look with the op's changes (null clears a
 * field). For `add` only the fields given; for `set`, null for the whole look if nothing is left.
 */
function lookOf(own: Look, op: Edit, adding: boolean): { look?: Look | null } {
  if (op.block === undefined && op.glow === undefined && op.tint === undefined) return {};
  const merged: Record<string, unknown> = adding ? {} : { ...own };
  const apply = (key: string, value: unknown) => {
    if (value === undefined) return;
    if (value === null) delete merged[key];
    else merged[key] = value;
  };
  apply("block", op.block);
  apply("glow", op.glow);
  apply("tint", op.tint);
  if (adding) return Object.keys(merged).length > 0 ? { look: merged as Look } : {};
  return { look: Object.keys(merged).length > 0 ? (merged as Look) : null };
}

/** The form argument for a set: the own form with shape or placement changed, or undefined. */
function formOf(own: Form | undefined, op: Edit): Form | null | undefined {
  if (op.shape === undefined && op.placement === undefined) return undefined;
  const merged: Record<string, unknown> = { ...own };
  if (op.shape === null) delete merged.shape;
  else if (op.shape !== undefined) merged.shape = op.shape;
  if (op.placement === null) delete merged.placement;
  else if (op.placement !== undefined) merged.placement = PLACEMENTS[op.placement];
  return Object.keys(merged).length > 0 ? (merged as Form) : null;
}

/** Warnings for blocks the host's libraries don't have (the semantic is set anyway). */
async function unknownBlocks(host: ToolHost, ops: readonly Edit[]): Promise<string[]> {
  if (!host.libraries) return [];
  const libraries = await host.libraries();
  if (libraries.size === 0) return [];
  const out: string[] = [];
  for (const op of ops) {
    if (op.block == null) continue;
    const ref = parseBlockRef(op.block);
    const found = ref && libraries.get(ref.library)?.blocks[ref.block];
    if (!found) {
      out.push(
        `${op.semantic}: block "${op.block}" isn't in the loaded libraries; use find_blocks.`,
      );
    }
  }
  return out;
}
