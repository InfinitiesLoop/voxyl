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
# Local ids (Blocks + SchematicaMapping/BlockMapping): every reader that matters resolves a
# block through the name table (Schematica: SchematicaMapping; GTNH's WorldEdit fork:
# BlockMapping), so the local numbers are arbitrary — but they are kept inside the Blocks byte
# (1-255) so the file never needs AddBlocks at all. That tag is the one place the readers
# disagree: Schematica unpacks its nibbles high-first, WorldEdit/MCEdit low-first, so any id past
# 255 came out as garbage in one of them (an earlier version wrote this install's real numeric
# ids, thousands for modded blocks, and Schematica showed gravel/mushrooms/soul sand and blocks
# out of thin air — see SchematicaWriter). When the block's real id (McId.get_legacy_id, from
# NEI's item.csv) happens to fit in a byte it is still used, so a raw-id reader on this install
# stays correct for vanilla-range blocks; everything else gets a free id counted down from 255,
# far from the low vanilla ids (1 stone, 3 dirt, …) a raw reader would otherwise paste. Only a
# file with more than 255 distinct blocks spills past 255 into AddBlocks.

# Export the box [mn, mx] (inclusive) of `data`, belonging to whichever project is currently
# active/resolving. To export a project that isn't the open one, wrap the call in
# VoxelWorld.begin_resolve_as/end_resolve_as first (the same pattern PrefabTools already uses
# for background renders). `turns`: see export_cells — pass the owning project's export_turns()
# so its north comes out facing the game's north.
static func export_region(data: VoxelData, mn: Vector3i, mx: Vector3i, turns := 0) -> Dictionary:
	var cells := {}
	for p in RegionOps.cells_in(data, mn, mx):
		cells[p - mn] = data.get_cell(p)
	return export_cells(cells, mx - mn + Vector3i.ONE, turns)

# Export a whole prefab, resolved through its own preferred palette stack (see
# CaptureService.prefab_stage — the same stand-in project its thumbnail renders use). Turned by
# the prefab's own north like a project region (a prefab of unknown north is written as it is).
static func export_prefab(prefab: Prefab) -> Dictionary:
	VoxelWorld.begin_resolve_as(CaptureService.prefab_stage(prefab))
	var out := export_cells(prefab.data.cells, prefab.size, VoxelProject.turns_between(prefab.north_dir, "north"))
	VoxelWorld.end_resolve_as()
	return out

const _BYTE_MAX := 255   # the Blocks byte; ids past this need AddBlocks (see class doc)

# The primitive both of the above (and SaveRegionDialog's UI export flow, which needs to
# build its own `cells` after applying the user's include/exclude + trim choices) funnel
# into. `cells`: Dictionary[Vector3i (relative to the box's own min corner), BlockCell].
# `size`: the box's dimensions. Resolves each semantic through whatever palette stack is
# currently active for resolution (VoxelWorld._resolve_project) — a plain call resolves
# against the live open project; wrap the call in VoxelWorld.begin_resolve_as/end_resolve_as
# first to resolve against a prefab's own stack instead (see export_prefab above).
# `turns`: quarter-turns clockwise (seen from above) to swing the whole box before writing it,
# blocks' facings and parts' slots with it — a project passes its own export_turns() so that its
# north (VoxelProject.north_dir) ends up on -Z, the north of the world the schematic is pasted
# into. A turned export's report carries `size` as written and `turned_degrees`.
# Returns {bytes: PackedByteArray, report: Dictionary}.
static func export_cells(cells: Dictionary, size: Vector3i, turns := 0) -> Dictionary:
	turns = posmod(turns, 4)
	if turns != 0:
		var turned := RegionOps.turned_box(cells, size, turns)
		cells = turned["cells"]
		size = turned["size"]
	var volume := maxi(0, size.x) * maxi(0, size.y) * maxi(0, size.z)
	var local_ids := PackedInt32Array()
	local_ids.resize(volume)
	var metas := PackedByteArray()
	metas.resize(volume)
	var mapping := {}     # registry string -> local id (from 1; 0 stays "air")
	var used_ids := {}    # local id -> true, so a real legacy id and a fallback never collide
	var mapped := {}      # registry string -> cell count, for the report
	var unmapped := {}    # semantic name -> cell count (no confirmed identity)
	var material_warnings := {}   # semantic name -> cell count (confirmed identity, not FMP-sawable)
	var tile_entities := []
	var cells_written := 0
	var empty_part_cells := 0   # a part cell where nothing in it resolved to a real block

	for rel: Vector3i in cells:
		if rel.x < 0 or rel.y < 0 or rel.z < 0 or rel.x >= size.x or rel.y >= size.y or rel.z >= size.z:
			continue
		var cell: BlockCell = cells[rel]
		var idx := (rel.y * size.z + rel.z) * size.x + rel.x
		if cell.is_shaped():
			var placeholder := _export_parts(cell, rel, mapping, used_ids, mapped, unmapped, tile_entities, material_warnings)
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
	var report := {
		"size": size,
		"cells_written": cells_written,
		"distinct_blocks": mapping.size(),
		"mapped": mapped,
		"unmapped": unmapped,
		"tile_entities": tile_entities.size(),
		"empty_part_cells": empty_part_cells,
	}
	if not material_warnings.is_empty():
		report["material_warnings"] = material_warnings
	if turns != 0:
		report["turned_degrees"] = turns * 90
	return {"bytes": bytes, "report": report}

# The local id for `registry`, assigning one on first use: this install's real numeric id when
# it's known, fits the Blocks byte and nothing else already claimed it, otherwise the highest
# free byte-sized id — see the class doc for why the ids stay under 256.
static func _local_id(registry: String, mapping: Dictionary, used_ids: Dictionary, legacy_id: int) -> int:
	if mapping.has(registry):
		return mapping[registry]
	var id: int
	if legacy_id >= 1 and legacy_id <= _BYTE_MAX and not used_ids.has(legacy_id):
		id = legacy_id
	else:
		# Counting down from the top of the byte keeps clear of the low, common vanilla ids
		# (1 stone, 3 dirt, 4 cobblestone, …) a raw-id reader would paste in place of these.
		id = _BYTE_MAX
		while id >= 1 and used_ids.has(id):
			id -= 1
		if id < 1:
			# All 255 byte-sized ids are taken: the only case that needs AddBlocks.
			id = _BYTE_MAX + 1
			while used_ids.has(id):
				id += 1
	mapping[registry] = id
	used_ids[id] = true
	return id

# Builds and appends this part cell's tile entity, registering its placeholder block in
# `mapping`/`mapped` (exactly like a whole block). Returns the placeholder's registry name, or
# "" if nothing in the cell resolved to a confirmed Minecraft identity.
static func _export_parts(cell: BlockCell, rel: Vector3i, mapping: Dictionary, used_ids: Dictionary,
		mapped: Dictionary, unmapped: Dictionary, tile_entities: Array, material_warnings: Dictionary) -> String:
	if cell.parts.size() == 1 and ShapeCatalog.is_exclusive(str(cell.parts[0].get("shape", ""))):
		return _export_arch_part(cell.parts[0], rel, mapping, used_ids, mapped, unmapped, tile_entities)
	return _export_microblock_parts(cell.parts, rel, mapping, used_ids, mapped, unmapped, tile_entities, material_warnings)

static func _export_arch_part(part: Dictionary, rel: Vector3i, mapping: Dictionary, used_ids: Dictionary,
		mapped: Dictionary, unmapped: Dictionary, tile_entities: Array) -> String:
	var semantic := str(part.get("semantic", ""))
	var bt := VoxelWorld.get_block_type_object_for_semantic(semantic)
	var tag := AcParts.tile_tag(rel, str(part.get("shape", "")), int(part.get("slot", -1)), bt) if bt != null else {}
	if tag.is_empty():
		unmapped[semantic] = int(unmapped.get(semantic, 0)) + 1
		return ""
	tile_entities.append(tag)
	var registry := AcParts.world_registry(VoxelWorld.get_shape_glow_for_semantic(semantic))
	_mark_placeholder(registry, mapping, used_ids, mapped)
	return registry

static func _export_microblock_parts(parts: Array, rel: Vector3i, mapping: Dictionary, used_ids: Dictionary,
		mapped: Dictionary, unmapped: Dictionary, tile_entities: Array, material_warnings: Dictionary) -> String:
	var part_tags := []
	for part: Dictionary in parts:
		var semantic := str(part.get("semantic", ""))
		var bt := VoxelWorld.get_block_type_object_for_semantic(semantic)
		var tag := FmpParts.part_tag(str(part.get("shape", "")), int(part.get("slot", -1)), bt) if bt != null else {}
		if tag.is_empty():
			unmapped[semantic] = int(unmapped.get(semantic, 0)) + 1
		else:
			part_tags.append(tag)
			if not FmpParts.material_warning(bt, str(part.get("shape", ""))).is_empty():
				material_warnings[semantic] = int(material_warnings.get(semantic, 0)) + 1
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
