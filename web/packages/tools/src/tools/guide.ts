// The working conventions, in one place. Status carries a one-line reminder; this is the
// document an agent reads once. It describes the tools that exist, not the Godot app's set.

import { z } from "zod";
import { defineTool } from "../tool.ts";

const TOPICS = [
  "overview",
  "axes",
  "semantics",
  "regions",
  "shapes",
  "editing",
  "prefabs",
  "seeing",
  "workflow",
] as const;

const SECTIONS: Record<(typeof TOPICS)[number], { title: string; text: string }> = {
  overview: {
    title: "Overview",
    text:
      "Voxyl is a voxel design tool. You are connected to the user's running editor: every edit " +
      'shows up live, and every mutating call is one undo step named "Claude: <tool>". ' +
      'Voxel data stores intent, not materials. Cells hold semantic names ("Wall", "Trim"). ' +
      "Palettes map each name to a block and, optionally, a shape. Change materials with " +
      "palette_edit; placement tools take semantics only. A semantic no palette maps yet is fine: " +
      "it renders undecided. Call status first to see what is open.",
  },
  axes: {
    title: "Axes",
    text:
      "Positions are integer cells [x, y, z]. +Y is up. North is -Z, south is +Z, west is -X, " +
      "east is +X. Direction words: up, down, north, south, east, west. A project's north setting " +
      "says which of its own directions is the real north; prefabs and the clipboard are turned " +
      "so north stays north when they cross projects.",
  },
  semantics: {
    title: "Semantics and palettes",
    text:
      "A semantic is a name in a palette. palette_get lists the stack or one palette's entries " +
      "(block, shape, glow, how many cells). palette_edit adds, sets, renames or removes entries " +
      "in one call; a rename keeps the cells. find_blocks searches the block libraries. " +
      "Names are exact, then case-insensitive when unambiguous. Two palettes can share a name: " +
      "pass {name, palette}. Reading never creates a semantic a palette could derive but has not.",
  },
  regions: {
    title: "Regions",
    text:
      "Every tool that targets cells takes the same region. {box:[x0,y0,z0,x1,y1,z1]} is inclusive, " +
      'any corner order. {selection:true} is the user\'s selection. {semantic:"Name"} is the cells ' +
      'holding it (a block or a part), not its bounding box. {palette:"Name"} is every semantic ' +
      "of that palette. {structure:{seed:[x,y,z]}} is the connected cells from a seed. " +
      "{all:[...]} intersects, {any:[...]} unions, {not:region} subtracts inside an intersection. " +
      "{grow:n, of:region} and {shrink:n, of:region} step a set of cells; they do not move a box's " +
      "faces. select sets the user's selection from a region; other tools can pass the region " +
      "straight through and skip select.",
  },
  shapes: {
    title: "Shapes and orientation",
    text:
      "The palette entry decides whether a semantic is a whole block or a part. One cell holds " +
      "either one block or several parts. describe_shapes lists shapes, or one shape's slots. " +
      'Microblock slots name the sides the part sits on: "north", "south-east", ' +
      '"down-north-west", "center-y". Roof and slope shapes take a whole cell: up is where the ' +
      "top points, facing is where the low end looks. Torch-like blocks take attached_to (down " +
      "means standing on the block below; a side means leaning out of that wall) instead of " +
      "facing. place merges parts into a cell; a part that cannot exist is rejected with a reason " +
      "(slot_taken, exclusive, bad_slot, ...).",
  },
  editing: {
    title: "Editing",
    text:
      "place sets cells. fill styles a region's box: solid, hollow, walls, frame, floor. clear " +
      "empties a region, or only one semantic. replace relabels one semantic as another and keeps " +
      'orientation. build reads text layers (origin, legend, layers; "." leaves a cell, "_" ' +
      "clears it). transform moves, copies, turns or mirrors a region. copy and paste use the " +
      "clipboard, which lives across projects. " +
      "place, fill, clear, replace, build, paste and prefab_place take symmetry and repeat. " +
      "symmetry is {rotate4:[x,z]} or {rotate2:[x,z]} (a centre; .5 is a cell boundary), " +
      "mirror_x and mirror_z (the plane x= or z=). repeat is {count:n or [nx,ny,nz], step:[dx,dy,dz]} " +
      "and runs after symmetry. Design one quarter and let symmetry fill the rest. " +
      "dry_run reports the change and writes nothing. op_id makes a repeat of the same call a no-op.",
  },
  prefabs: {
    title: "Prefabs and projects",
    text:
      "A prefab is a named piece kept outside any project (a pillar, a bay, a tree). prefab_save " +
      "a region, prefab_list and prefab_get describe them, prefab_place stamps one (turn, mirror, " +
      "symmetry, repeat), prefab_edit renames, retags or moves its anchor. A placed prefab is " +
      "plain cells. It resolves through the open project's palettes; semantics the project does " +
      "not map are reported, and add_palettes adds the prefab's preferred palettes. " +
      "project_list, project_open, project_create, project_settings, project_save and " +
      "project_delete manage saved projects. Opening one replaces the editor's project.",
  },
  seeing: {
    title: "Seeing the build",
    text:
      "inspect is the cheap exact view: summary, materials, layers or a page of cells. " +
      "capture renders offscreen from a compass side and an elevation; the user's camera does " +
      "not move. capture_sheet packs several of those into one labelled image (review, " +
      "elevations, turntable, or compare over several regions). Both need the editor tab, and " +
      "they show whatever is already meshed. view_set, tool_set, cutaway and hotbar_set change " +
      "what the user is looking at; use them to hand a view over, not to inspect. " +
      "export_schematic writes a Schematica .schematic (the file downloads in the editor) and " +
      "reports what could not be written. Semantics stay semantics until that export: a block " +
      "with no Minecraft identity is left out, not guessed. probe_schematic reads a .schematic " +
      "back (pass the file as base64).",
  },
  workflow: {
    title: "A workflow that works",
    text:
      "status, then guide if you need a section again. find_blocks and palette_edit to decide " +
      "materials. build or place, with symmetry, for the form. inspect or capture_sheet " +
      '{preset:"review"} to check it. history to undo. prefab_save anything you will repeat, ' +
      "then prefab_place it. export_schematic when the build should load in a world that reads " +
      "Schematica files. Pass dry_run before a large edit.",
  },
};

export const guide = defineTool({
  name: "guide",
  title: "How to build in Voxyl",
  description:
    "The working conventions, read once: axes, semantics, regions, shapes, symmetry, prefabs " +
    "and which tool does what. Pass topic for one section " +
    `(${TOPICS.join(", ")}). status is the short reminder; this is the full note.`,
  input: z.strictObject({
    topic: z.enum(TOPICS).optional().describe("One section. Omit it for the whole guide."),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  needsProject: false,
  handler(_host, args) {
    if (args.topic) {
      const section = SECTIONS[args.topic];
      return { topic: args.topic, title: section.title, text: section.text };
    }
    return {
      topics: TOPICS,
      text: TOPICS.map((topic) => `## ${SECTIONS[topic].title}\n${SECTIONS[topic].text}`).join(
        "\n\n",
      ),
    };
  },
});
