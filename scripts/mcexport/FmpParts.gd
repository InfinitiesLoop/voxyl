class_name FmpParts
extends RefCounted

# Translates placed ShapeCatalog microblock parts into ForgeMultipart's own tile-entity NBT —
# confirmed against the GTNH fork's real source (codechicken/multipart, codechicken/microblock),
# not guessed:
#   - every multipart tile in any real save (not just a load-time artifact) writes
#     "id" = "savedMultipart": TileMultipart.writeToNBT stamps it via Vanilla's own
#     class->name reflection map, which FMP patches at startup to point every ASM-generated
#     multipart tile class at this one literal string (MultipartSaveLoad.scala).
#   - the tile's own "parts" TAG_List holds one compound per part: {"id": registered part
#     type name, "shape": (size<<4|slot) packed byte, "material": MicroMaterialRegistry key}
#     (Microblock.save/load — shared verbatim by every microblock subclass; none override it).
#   - FMP's placeholder world block is "ForgeMultipart:block", always placed at metadata 0
#     (BlockMultipart.scala's registration; MultipartGenerator.scala's world.setBlock calls).
#   - the "material" string is exactly the block's own Minecraft registry name
#     (McId.fmp_material_key — confirmed against BlockMicroMaterial.materialKey; earlier code
#     here assumed a separate "unlocalized name" identity, which turned out to be wrong: FMP's
#     real materialKey uses the registry name, same as everything else), with "_<meta>"
#     appended for a non-zero meta.
#   - slot numbering: FACE/HOLLOW store PartMap's face index (0-5) unmodified; CORNER stores
#     its corner index (0-7) unmodified; EDGE (non-centered) stores its edge index (0-11)
#     unmodified — ShapeCatalog's own numbering already ports PartMap exactly (see its own
#     header comment), so none of these need translating. A centered post (ShapeCatalog's
#     CENTER_SLOT + axis) is FMP's own separate registered part type ("mcr_post",
#     PostMicroblock) rather than a special EdgeMicroblock slot; its stored low nibble is the
#     axis index (0 Y, 1 Z, 2 X), matching ShapeCatalog's own axis-group numbering.

const WORLD_REGISTRY := "ForgeMultipart:block"
const TILE_ID := "savedMultipart"

const _PART_ID := {
	ShapeCatalog.Family.FACE: "mcr_face",
	ShapeCatalog.Family.HOLLOW: "mcr_hllw",
	ShapeCatalog.Family.CORNER: "mcr_cnr",
}

# The NBT compound for one placed part (Microblock.save's fields), or {} if `bt` carries no
# confirmed Minecraft identity — nothing to write, never guessed.
static func part_tag(shape_id: String, slot: int, bt: BlockType) -> Dictionary:
	var material := McId.fmp_material_key(bt)
	if material.is_empty():
		return {}
	var family := ShapeCatalog.family_of(shape_id)
	var size := ShapeCatalog.size_of(shape_id)
	var part_id: String
	var stored_slot: int
	if family == ShapeCatalog.Family.EDGE and slot >= ShapeCatalog.CENTER_SLOT:
		part_id = "mcr_post"
		stored_slot = slot - ShapeCatalog.CENTER_SLOT
	elif family == ShapeCatalog.Family.EDGE:
		part_id = "mcr_edge"
		stored_slot = slot
	elif _PART_ID.has(family):
		part_id = _PART_ID[family]
		stored_slot = slot
	else:
		return {}
	return {
		"id": NbtWriter.tag_string(part_id),
		"shape": NbtWriter.tag_byte((size << 4) | stored_slot),
		"material": NbtWriter.tag_string(material),
	}

# The multipart tile entity compound for a cell's worth of already-built part tags.
static func tile_tag(pos: Vector3i, part_tags: Array) -> Dictionary:
	return {
		"id": NbtWriter.tag_string(TILE_ID),
		"x": NbtWriter.tag_int(pos.x),
		"y": NbtWriter.tag_int(pos.y),
		"z": NbtWriter.tag_int(pos.z),
		"parts": NbtWriter.tag_list(NbtWriter.TYPE_COMPOUND, part_tags),
	}
