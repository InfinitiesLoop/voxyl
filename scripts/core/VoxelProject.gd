class_name VoxelProject
extends Resource

@export var name: String = ""
@export var data: VoxelData
# Ordered palette references. Resolution is last-wins across the stack.
@export var palette_names: Array[String] = []

# Lifecycle timestamps (Unix seconds). created_at is stamped once at add_project;
# modified_at is re-stamped on every ProjectStore.save_project. Both persist. Legacy
# projects saved before these existed load as 0 → shown as "unknown" / sorted last
# until their next save. These are metadata about the build, not part of the voxel data.
@export var created_at: int = 0
@export var modified_at: int = 0

# Project-tied editor state (persisted alongside the voxel data). These are NOT the
# voxel data — they're the workspace arrangement for this build, kept here so they
# belong to the project (all views) rather than any single view (Principle 2):
#   layout      — opaque view-arrangement descriptor produced/consumed by
#                 MultiViewShell (split tree + panes + per-view camera/pan/zoom). The
#                 data layer never interprets it.
#   hotbar      — the 12 semantic names loaded into slots ("" = empty). Intent, not
#                 materials — same contract as the voxel data.
#   active_slot — which hotbar slot is selected.
@export var layout: Dictionary = {}
@export var hotbar: Array[String] = []
@export var active_slot: int = 0

# Where this project sits in the world it plans (project settings, edited in the Project dialog;
# like layout/hotbar they belong to the build, never to a view, and are never voxel data):
#   north_dir   — which of the project's own directions points toward the real world's north:
#                 "north" (-Z, the default: the project is already aligned), "east" (+X),
#                 "south" (+Z) or "west" (-X). It orients the compass, and it makes north
#                 transparent wherever cells cross between frames (see turns_between): a
#                 prefab saved here remembers it, one placed (or a copy pasted) here is turned
#                 to it, and a Schematica export is turned so this side faces the game's
#                 north. The data itself is never rotated: every direction word in the data
#                 and the tools keeps meaning the project's own axes.
#   grid_offset — where the heavy 16-cell grid lines fall: along the west / north edge of the
#                 cells whose x / z is this value (mod 16), so the grid can be lined up with the
#                 world's chunk borders when the project's origin isn't on one. Kept in 0..15.
const NORTH_DIRS := ["north", "east", "south", "west"]
const MAJOR_GRID := 16
@export var north_dir: String = "north"
@export var grid_offset: Vector2i = Vector2i.ZERO

# The project's north as a direction on the ground plane, in (x, z) — z grows southward.
func north_vector() -> Vector2:
	match north_dir:
		"east": return Vector2(1, 0)
		"south": return Vector2(0, 1)
		"west": return Vector2(-1, 0)
	return Vector2(0, -1)

# "North is north": a build laid out in a frame whose north is the direction `from_north` (a
# NORTH_DIRS word), moved into a frame whose north is `to_north`, must be turned by this many
# quarter-turns clockwise (seen from above, the sense of RegionOps.turn_basis) for its north to
# stay the real north. Every frame has one: a project (north_dir), a prefab (Prefab.north_dir), the
# clipboard (the project it was copied from), and a Schematica file or the game itself ("north":
# -Z). Moving cells between any two of them is this turn, and nothing else. An unknown frame ("",
# a prefab saved before north existed) turns nothing.
static func turns_between(from_north: String, to_north: String) -> int:
	var a := NORTH_DIRS.find(from_north)
	var b := NORTH_DIRS.find(to_north)
	if a < 0 or b < 0:
		return 0
	return posmod(b - a, 4)

# The turn an export applies so this project's north lands on -Z, the north of the game a
# Schematica file is pasted into: east (+X) needs 3, south 2, west 1, none for the default.
func export_turns() -> int:
	return turns_between(north_dir, "north")

# Cuboid region selection (the Select tool), persisted as two opposite corners + a flag —
# cheap, and enough to restore the exact box. Like layout/hotbar this is project-tied
# editor state, not voxel data: it names positions, never a material.
@export var has_selection: bool = false
@export var selection_min: Vector3i = Vector3i.ZERO
@export var selection_max: Vector3i = Vector3i.ZERO

# The cutaway box (see VoxelWorld.set_cutaway): cells inside it are hidden from the 3D views
# so you can see and build inside. Editor state like the selection, never voxel data.
@export var has_cutaway: bool = false
@export var cutaway_min: Vector3i = Vector3i.ZERO
@export var cutaway_max: Vector3i = Vector3i.ZERO
@export var cutaway_enabled: bool = true

# Undo/redo history for this build's voxel edits. `history` is the live runtime object
# (an EditHistory of EditOperation deltas); `_history_data` is its packed on-disk mirror,
# the ONLY thing persisted — exactly the split VoxelData uses for `cells` vs its packed
# arrays, so history serializes as compact plain data, never one sub-resource per step.
# pack_history()/unpack_history() bridge the two (called by ProjectStore around save/load).
var history: EditHistory
@export var _history_data: Dictionary = {}

# A scratch project lives in memory only: ProjectStore never writes it until it's promoted
# (VoxelWorld.save_project_as clears this). Not exported — a saved project is never scratch.
var scratch := false

func _init() -> void:
	data = VoxelData.new()
	history = EditHistory.new()

# Flatten the live history into its packed mirror. Called by ProjectStore just before save,
# alongside data.pack().
func pack_history() -> void:
	if history != null:
		_history_data = history.to_data()

# Rebuild the live history from its packed mirror. Called by ProjectStore after load,
# alongside data.unpack(). A legacy project (no saved history) rebuilds as empty.
func unpack_history() -> void:
	history = EditHistory.from_data(_history_data)

# Returns all semantic names currently placed in this project's voxel data.
func used_semantic_names() -> Array[String]:
	data.ensure_loaded()
	var seen := {}
	for cell: BlockCell in data.cells.values():
		if cell.is_shaped():
			for p in cell.parts:
				seen[str(p["semantic"])] = true
		else:
			seen[cell.type_id] = true
	var result: Array[String] = []
	result.assign(seen.keys())
	return result

# Semantic name → placed count (cells for plain blocks, parts for shaped ones), for the
# project details breakdown.
func semantic_counts() -> Dictionary:
	data.ensure_loaded()
	var counts := {}
	for cell: BlockCell in data.cells.values():
		if cell.is_shaped():
			for p in cell.parts:
				var s := str(p["semantic"])
				counts[s] = counts.get(s, 0) + 1
		else:
			counts[cell.type_id] = counts.get(cell.type_id, 0) + 1
	return counts

# Set when this project is a prefab opened for editing (VoxelWorld.open_prefab_for_editing):
# an in-memory stand-in (scratch, never listed or written as a project) whose saves write its
# cells back into the prefab. `prefab_origin` is where the prefab's box min corner sits in
# this project's coordinates (it moves if edits grow the box toward -x/-y/-z).
var editing_prefab: Prefab = null
var prefab_origin := Vector3i.ZERO
var prefab_saved_sig := ""
