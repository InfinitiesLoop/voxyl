class_name SchematicaExporter
extends RefCounted

# Exports a region (an open project's box, or an entire prefab) to Schematica's .schematic
# format. Resolves each cell through the normal semantic -> BlockType palette walk
# (VoxelWorld.get_block_type_object_for_semantic) so it sees exactly what the 3D view renders,
# then keeps only cells/parts whose resolved BlockType carries a CONFIRMED Minecraft identity
# (McId.has_registry) — an "undecided"/voxyl-only block has no real MC block to write, and
# guessing one would produce a wrong, silently-broken .schematic. Everything that can't be
# included (no confirmed identity, or an architecture shape/GT machine with no known export
# mapping) is bucketed into the report instead of silently dropped, so a caller can show the
# user exactly what did and didn't make it in.
#
# A shaped/part cell becomes a real tile entity (see FmpParts, AcParts for the exact NBT and
# the real-source citations behind it) plus a placeholder block in Blocks/Data at that
# position — a ForgeMultipart multipart tile for microblock parts (face/hollow/edge/corner),
# or a single ArchitectureCraft TileShape for an architecture-shape cell (ShapeCatalog.ARCH;
# these always keep their cell to themselves, see .plans/shaped-parts.md). GT machines aren't
# wired up yet.
#
# Local ids (Blocks/AddBlocks + SchematicaMapping): Schematica itself only ever reads
# SchematicaMapping, so historically these were arbitrary small numbers (1, 2, 3…). But a tool
# that DOESN'T know that tag (confirmed against GTNH's own WorldEdit fork) instead reads
# Blocks/AddBlocks as raw live numeric block ids — and small arbitrary numbers collide head-on
# with low vanilla ids (1 = stone, 3 = dirt, 4 = cobblestone, …), so the file silently pastes
# the wrong blocks everywhere. Using this install's OWN real numeric id (McId.get_legacy_id,
# captured from NEI's item.csv at import time) as the local id instead makes one file correct
# for both kinds of reader — SchematicaMapping-aware or not — as long as that id fits the
# format's 12-bit cap (0-4095; the same cap Schematica itself is limited by). Falls back to an
# arbitrary free number when there's no known legacy id (a manually-set/healed identity with no
# roster row, or one over the cap) — still correct for Schematica, just not for a raw reader.

# Export the box [mn, mx] (inclusive) of `data`, belonging to whichever project is currently
# active/resolving. To export a project that isn't the open one, wrap the call in
# VoxelWorld.begin_resolve_as/end_resolve_as first (the same pattern PrefabTools already uses
# for background renders).
static func export_region(data: VoxelData, mn: Vector3i, mx: Vector3i) -> Dictionary:
	var cells := {}
	for p in RegionOps.cells_in(data, mn, mx):
		cells[p - mn] = data.get_cell(p)
	return export_cells(cells, mx - mn + Vector3i.ONE)

# Export a whole prefab, resolved through its own preferred palette stack (see
# CaptureService.prefab_stage — the same stand-in project its thumbnail renders use).
static func export_prefab(prefab: Prefab) -> Dictionary:
	VoxelWorld.begin_resolve_as(CaptureService.prefab_stage(prefab))
	var out := export_cells(prefab.data.cells, prefab.size)
	VoxelWorld.end_resolve_as()
	return out

const _MAX_LOCAL_ID := 4095   # 12-bit cap: Blocks' byte + AddBlocks' nibble

# The primitive both of the above (and SaveRegionDialog's UI export flow, which needs to
# build its own `cells` after applying the user's include/exclude + trim choices) funnel
# into. `cells`: Dictionary[Vector3i (relative to the box's own min corner), BlockCell].
# `size`: the box's dimensions. Resolves each semantic through whatever palette stack is
# currently active for resolution (VoxelWorld._resolve_project) — a plain call resolves
# against the live open project; wrap the call in VoxelWorld.begin_resolve_as/end_resolve_as
# first to resolve against a prefab's own stack instead (see export_prefab above).
# Returns {bytes: PackedByteArray, report: Dictionary}.
static func export_cells(cells: Dictionary, size: Vector3i) -> Dictionary:
	var volume := maxi(0, size.x) * maxi(0, size.y) * maxi(0, size.z)
	var local_ids := PackedInt32Array()
	local_ids.resize(volume)
	var metas := PackedByteArray()
	metas.resize(volume)
	var mapping := {}     # registry string -> local id (from 1; 0 stays "air")
	var used_ids := {}    # local id -> true, so a real legacy id and a fallback never collide
	var mapped := {}      # registry string -> cell count, for the report
	var unmapped := {}    # semantic name -> cell count (no confirmed identity)
	var tile_entities := []
	var cells_written := 0
	var empty_part_cells := 0   # a part cell where nothing in it resolved to a real block

	for rel: Vector3i in cells:
		if rel.x < 0 or rel.y < 0 or rel.z < 0 or rel.x >= size.x or rel.y >= size.y or rel.z >= size.z:
			continue
		var cell: BlockCell = cells[rel]
		var idx := (rel.y * size.z + rel.z) * size.x + rel.x
		if cell.is_shaped():
			var placeholder := _export_parts(cell, rel, mapping, used_ids, mapped, unmapped, tile_entities)
			if placeholder.is_empty():
				empty_part_cells += 1
				continue
			local_ids[idx] = mapping[placeholder]
			cells_written += 1
			continue
		var bt := VoxelWorld.get_block_type_object_for_semantic(cell.type_id)
		if bt == null or not McId.has_registry(bt):
			unmapped[cell.type_id] = int(unmapped.get(cell.type_id, 0)) + 1
			continue
		var registry := McId.get_registry(bt)
		local_ids[idx] = _local_id(registry, mapping, used_ids, McId.get_legacy_id(bt))
		metas[idx] = SchematicaMeta.final_meta(bt, cell.orientation) & 0xFF
		mapped[registry] = int(mapped.get(registry, 0)) + 1
		cells_written += 1

	var bytes := SchematicaWriter.write(size, local_ids, metas, mapping, tile_entities)
	return {"bytes": bytes, "report": {
		"size": size,
		"cells_written": cells_written,
		"distinct_blocks": mapping.size(),
		"mapped": mapped,
		"unmapped": unmapped,
		"tile_entities": tile_entities.size(),
		"empty_part_cells": empty_part_cells,
	}}

# The local id for `registry`, assigning one on first use: this install's real numeric id when
# it's known and fits the 12-bit cap and nothing else already claimed it, otherwise the lowest
# free number — see the class doc for why real ids matter here.
static func _local_id(registry: String, mapping: Dictionary, used_ids: Dictionary, legacy_id: int) -> int:
	if mapping.has(registry):
		return mapping[registry]
	var id: int
	if legacy_id >= 1 and legacy_id <= _MAX_LOCAL_ID and not used_ids.has(legacy_id):
		id = legacy_id
	else:
		# Every low, common vanilla id (1 stone, 3 dirt, 4 cobblestone, …) lives down here — a
		# raw-id reader that doesn't know this file's SchematicaMapping (see class doc) would
		# paste one of THOSE instead of leaving it as whatever the fallback was standing in for.
		# Counting down from the top of the range instead is far less likely to land on
		# something real and meaningful to such a reader (FMP/AC's own placeholder blocks are
		# the only regulars here — no item form, so no legacy id to look up in the first place).
		id = _MAX_LOCAL_ID
		while used_ids.has(id):
			id -= 1
	mapping[registry] = id
	used_ids[id] = true
	return id

# Builds and appends this part cell's tile entity, registering its placeholder block in
# `mapping`/`mapped` (exactly like a whole block). Returns the placeholder's registry name, or
# "" if nothing in the cell resolved to a confirmed Minecraft identity.
static func _export_parts(cell: BlockCell, rel: Vector3i, mapping: Dictionary, used_ids: Dictionary,
		mapped: Dictionary, unmapped: Dictionary, tile_entities: Array) -> String:
	if cell.parts.size() == 1 and ShapeCatalog.is_exclusive(str(cell.parts[0].get("shape", ""))):
		return _export_arch_part(cell.parts[0], rel, mapping, used_ids, mapped, unmapped, tile_entities)
	return _export_microblock_parts(cell.parts, rel, mapping, used_ids, mapped, unmapped, tile_entities)

static func _export_arch_part(part: Dictionary, rel: Vector3i, mapping: Dictionary, used_ids: Dictionary,
		mapped: Dictionary, unmapped: Dictionary, tile_entities: Array) -> String:
	var semantic := str(part.get("semantic", ""))
	var bt := VoxelWorld.get_block_type_object_for_semantic(semantic)
	var tag := AcParts.tile_tag(rel, str(part.get("shape", "")), int(part.get("slot", -1)), bt) if bt != null else {}
	if tag.is_empty():
		unmapped[semantic] = int(unmapped.get(semantic, 0)) + 1
		return ""
	tile_entities.append(tag)
	_mark_placeholder(AcParts.WORLD_REGISTRY, mapping, used_ids, mapped)
	return AcParts.WORLD_REGISTRY

static func _export_microblock_parts(parts: Array, rel: Vector3i, mapping: Dictionary, used_ids: Dictionary,
		mapped: Dictionary, unmapped: Dictionary, tile_entities: Array) -> String:
	var part_tags := []
	for part: Dictionary in parts:
		var semantic := str(part.get("semantic", ""))
		var bt := VoxelWorld.get_block_type_object_for_semantic(semantic)
		var tag := FmpParts.part_tag(str(part.get("shape", "")), int(part.get("slot", -1)), bt) if bt != null else {}
		if tag.is_empty():
			unmapped[semantic] = int(unmapped.get(semantic, 0)) + 1
		else:
			part_tags.append(tag)
	if part_tags.is_empty():
		return ""
	tile_entities.append(FmpParts.tile_tag(rel, part_tags))
	_mark_placeholder(FmpParts.WORLD_REGISTRY, mapping, used_ids, mapped)
	return FmpParts.WORLD_REGISTRY

# FMP/AC's own placeholder world blocks have no item form (nothing crafts/gives one directly —
# they only ever exist via a saw cut in-world), so there's no item.csv row and no BlockType to
# hang a legacy id off of the way a real semantic block gets one. block.csv is the only NEI
# dump that covers them (required as of NeiRosterImporter.load_block_csv), and ImportService
# parks whatever it finds on the library it imported into (BlockLibrary.mc_legacy_ids) —
# checked here across every library in the workspace, since it doesn't matter which one holds
# it. -1 (falls back to an arbitrary free id, same as any other unknown registry) for a
# workspace that hasn't reimported since block.csv became required.
static func _placeholder_legacy_id(registry: String) -> int:
	for lib: BlockLibrary in VoxelWorld.workspace.libraries:
		if lib.mc_legacy_ids.has(registry):
			return int(lib.mc_legacy_ids[registry])
	return -1

static func _mark_placeholder(registry: String, mapping: Dictionary, used_ids: Dictionary, mapped: Dictionary) -> void:
	_local_id(registry, mapping, used_ids, _placeholder_legacy_id(registry))
	mapped[registry] = int(mapped.get(registry, 0)) + 1
