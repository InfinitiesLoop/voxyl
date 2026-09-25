class_name SchematicaExporter
extends RefCounted

# Exports a whole-block region (an open project's box, or an entire prefab) to Schematica's
# .schematic format. Resolves each cell through the normal semantic -> BlockType palette walk
# (VoxelWorld.get_block_type_object_for_semantic) so it sees exactly what the 3D view renders,
# then keeps only cells whose resolved BlockType carries a CONFIRMED Minecraft identity
# (McId.has_registry) — an "undecided"/voxyl-only block has no real MC block to write, and
# guessing one would produce a wrong, silently-broken .schematic. Everything that can't be
# included (no confirmed identity, or a shaped/part cell — FMP/AC/GT export is a later step)
# is bucketed into the report instead of silently dropped, so a caller can show the user
# exactly what did and didn't make it in.

# Export the box [mn, mx] (inclusive) of `data`, belonging to whichever project is currently
# active/resolving. To export a project that isn't the open one, wrap the call in
# VoxelWorld.begin_resolve_as/end_resolve_as first (the same pattern PrefabTools already uses
# for background renders).
static func export_region(data: VoxelData, mn: Vector3i, mx: Vector3i) -> Dictionary:
	var cells := {}
	for p in RegionOps.cells_in(data, mn, mx):
		cells[p - mn] = data.get_cell(p)
	return _export(cells, mx - mn + Vector3i.ONE)

# Export a whole prefab, resolved through its own preferred palette stack (see
# CaptureService.prefab_stage — the same stand-in project its thumbnail renders use).
static func export_prefab(prefab: Prefab) -> Dictionary:
	VoxelWorld.begin_resolve_as(CaptureService.prefab_stage(prefab))
	var out := _export(prefab.data.cells, prefab.size)
	VoxelWorld.end_resolve_as()
	return out

# `cells`: Dictionary[Vector3i (relative to the box's own min corner), BlockCell]. `size`:
# the box's dimensions. Returns {bytes: PackedByteArray, report: Dictionary}.
static func _export(cells: Dictionary, size: Vector3i) -> Dictionary:
	var volume := maxi(0, size.x) * maxi(0, size.y) * maxi(0, size.z)
	var local_ids := PackedInt32Array()
	local_ids.resize(volume)
	var metas := PackedByteArray()
	metas.resize(volume)
	var mapping := {}     # registry string -> local id (from 1; 0 stays "air")
	var mapped := {}      # registry string -> cell count, for the report
	var unmapped := {}    # semantic name -> cell count (no confirmed identity)
	var cells_written := 0
	var skipped_parts := 0

	for rel: Vector3i in cells:
		if rel.x < 0 or rel.y < 0 or rel.z < 0 or rel.x >= size.x or rel.y >= size.y or rel.z >= size.z:
			continue
		var cell: BlockCell = cells[rel]
		if cell.is_shaped():
			skipped_parts += cell.parts.size()
			continue
		var bt := VoxelWorld.get_block_type_object_for_semantic(cell.type_id)
		if bt == null or not McId.has_registry(bt):
			unmapped[cell.type_id] = int(unmapped.get(cell.type_id, 0)) + 1
			continue
		var registry := McId.get_registry(bt)
		if not mapping.has(registry):
			mapping[registry] = mapping.size() + 1
		var idx := (rel.y * size.z + rel.z) * size.x + rel.x
		local_ids[idx] = mapping[registry]
		metas[idx] = SchematicaMeta.final_meta(bt, cell.orientation) & 0xFF
		mapped[registry] = int(mapped.get(registry, 0)) + 1
		cells_written += 1

	var bytes := SchematicaWriter.write(size, local_ids, metas, mapping)
	return {"bytes": bytes, "report": {
		"size": size,
		"cells_written": cells_written,
		"distinct_blocks": mapping.size(),
		"mapped": mapped,
		"unmapped": unmapped,
		"skipped_part_cells": skipped_parts,
	}}
