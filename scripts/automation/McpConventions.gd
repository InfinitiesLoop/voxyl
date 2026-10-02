class_name McpConventions
extends RefCounted

# What an agent needs to know once, instead of in every tool description: sent as the MCP
# server's `instructions` at initialize, and readable as the voxyl://conventions resource.

const INSTRUCTIONS := """Voxyl is a voxel design tool (Minecraft-inspired, not Minecraft-specific). You are connected to the user's running app: every edit shows up live in their window, and every mutating call is one undo step named "Claude: <tool>" in their history.

Core idea: voxel data stores INTENT, not materials. Cells hold semantic names ("Mass", "Trim", "Channel Glow"). Palettes map each semantic to a block from a library (its material) and optionally a shape (a sub-block part like a slab, strip or roof tile). Change materials only through palette tools; placement tools only take semantics. A semantic no palette maps yet is fine: it renders as undecided. A project uses a stack of palettes (last one wins).

Axes: +Y up; north = -Z, south = +Z, west = -X, east = +X. Positions are integer cells [x,y,z]. Direction words: up down north south east west (aliases +y -y -z +z +x -x).

Shaped parts: a palette entry with a shape places parts, never whole blocks. A cell holds either one whole block or several parts. Parts go in slots, named in words:
- faces/hollow faces (Cover 1/8, Panel 1/4, Slab 1/2): the side they lie against, e.g. "north"
- edges (Strip, Post, Pillar): the two sides they run between, e.g. "south-east" (vertical), "down-north" (runs along X), "up-west" (runs along Z); centered posts "center-y" etc.
- corners (Nook, Corner, Notch): three sides, e.g. "down-north-west"
- architecture shapes (roofs, stairs, cylinders, arches, ...) take a whole cell; orient them with {up, facing} (facing = the side their open/low side looks toward, e.g. a roof tile's downhill side). shape_describe / shape_orient explain each shape.
Placements that couldn't exist are rejected with a reason (slot_taken, micro_conflict, native_block, ...).

Attachable blocks (torches: torch, redstone/soul torch, flagged mod torches) hold on to a neighbour: place them with {attached_to:"down"} (standing on the block below, the default) or {attached_to:"north"|"east"|"south"|"west"} (leaning out of the wall on that side), or {facing} = the way they point (up = standing). They never hang from the block above: attached_to "up" is rejected with cant_attach. Nothing checks the holding block is there. cell_get reports facing + attached_to; block_get reports attachment; block_set_attachment flags a block the geometry can't identify.
Regions: {min:[x,y,z], max:[x,y,z]} (inclusive), {selection:true}, {semantic:"Name"} (where it's used), {all:true}; add pad:n to grow.
To act on "that walkway" instead of a box, structure_find {from:[x,y,z], semantics and/or palette, gap, diagonal} selects exactly the connected cells (a sparse selection: blocks that aren't part of it stay out even inside its bounding box); then pass {selection:true} as the region.
To select exactly what you mean from simpler pieces, selection_combine {operation:"union"|"except"|"intersect"|"xor", base?:Region (default: the current selection), with:Region|[Region,...]} sets the selection to the combined cells. A room's walls = base {box around the room}, except {its inner box}; everything but the ground = base {all:true}, except {the ground's box}. Only built cells count, so a box holds what's in it, not the air.
To make a box selection bigger or smaller, selection_resize {by:n} moves every face outward by n (negative = inward); x/y/z move one axis's two faces, up/down/north/south/east/west one face (by:2, y:0 = wider but not taller; up:-1 = lower the top). selection_grow/selection_shrink are different: they grow or erode a set of built cells and never move a box's faces.

Edit tools accept symmetry ({rotate4:{center:[x,z]}}, mirror_x, mirror_z, mirror_diag), repeat ({count, step}), dry_run and only_air. Design one quarter and let symmetry fill the rest.

Text layers (region_text / cells_place_layers): {origin, axis:"y", legend, layers}. axis y: layers go up from origin.y, rows run north->south from origin.z, characters west->east from origin.x. Legend: char -> "Semantic" | {semantic, facing, top} | [{semantic, slot}, ...] (a cell of parts). "." = untouched, "_" = clear. region_text writes the same format, so dumps round-trip.

Prefabs: named, reusable pieces (a pillar, a bay module, a tree), global to the workspace like palettes and shared with the user's Prefabs browser. prefab_save a region once, then prefab_place it as often as needed (rotate, mirror, repeat, symmetry) instead of clipboard round trips. A prefab stores semantics, never materials, plus a preferred palette stack for its own previews; placed into a project, it resolves through that project's palettes. prefab_place reports semantics the project doesn't map and which preferred palettes would; pass add_palettes:true to add those to the bottom of the stack.

Seeing the build: capture renders offscreen from any camera without touching the user's views ({frame: Region, from: "se"|yaw, elevation: "low"|"eye"|"high"|"top"|deg}); capture_sheet gives labeled multi-view sheets; region_text is the cheapest exact view. view_set moves the user's own camera (only when handing a view over).

After changing Voxyl's own code on disk, call restart to load it (needs the editor plugin; see the tool), then poll status until the app answers.
Workflow that works: block_search / block_swatches to pick materials -> palette_create -> project_create (scratch:true for experiments) -> build with cells_place_layers + symmetry -> capture_sheet {preset:"review"} -> fix -> project_save. Use status first to see what's open."""

static func resources() -> Array:
	return [{
		"uri": "voxyl://conventions",
		"name": "conventions",
		"title": "Voxyl conventions",
		"description": "Axes, slot names, regions, symmetry and the text layer format",
		"mimeType": "text/markdown",
	}]

static func read(uri: String) -> Dictionary:
	if uri == "voxyl://conventions":
		return {"uri": uri, "mimeType": "text/markdown", "text": INSTRUCTIONS}
	return {}
