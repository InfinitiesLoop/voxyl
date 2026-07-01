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

func _init() -> void:
	data = VoxelData.new()

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
