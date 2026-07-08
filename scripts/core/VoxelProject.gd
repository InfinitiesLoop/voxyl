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

# Cuboid region selection (the Select tool), persisted as two opposite corners + a flag —
# cheap, and enough to restore the exact box. Like layout/hotbar this is project-tied
# editor state, not voxel data: it names positions, never a material.
@export var has_selection: bool = false
@export var selection_min: Vector3i = Vector3i.ZERO
@export var selection_max: Vector3i = Vector3i.ZERO

# Undo/redo history for this build's voxel edits. `history` is the live runtime object
# (an EditHistory of EditOperation deltas); `_history_data` is its packed on-disk mirror,
# the ONLY thing persisted — exactly the split VoxelData uses for `cells` vs its packed
# arrays, so history serializes as compact plain data, never one sub-resource per step.
# pack_history()/unpack_history() bridge the two (called by ProjectStore around save/load).
var history: EditHistory
@export var _history_data: Dictionary = {}

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
	var seen := {}
	for cell: BlockCell in data.cells.values():
		seen[cell.type_id] = true
	var result: Array[String] = []
	result.assign(seen.keys())
	return result

# Semantic name → placed-cell count, for the project details breakdown. Reads the live
# cells dictionary (already unpacked in memory), so it's cheap to call at listing time.
func semantic_counts() -> Dictionary:
	var counts := {}
	for cell: BlockCell in data.cells.values():
		counts[cell.type_id] = counts.get(cell.type_id, 0) + 1
	return counts
