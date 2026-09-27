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

# Whether FMP's own saw can cut this block into a microblock — NOT fully decidable from
# config/microblocks.cfg alone (confirmed the hard way): that whitelist (ForgeMultipart's
# ConfigContent.scala, by registry name + an optional meta range) only covers materials whose
# OWN mod didn't integrate with FMP itself. A mod written by/with FMP's own author can — and
# does — self-register via MicroMaterialRegistry.registerMaterial() directly in its own code,
# invisible to the cfg file entirely: confirmed for ProjectRed's Illumination "Inverted Lamp"
# colors (metas 16-31 of ProjRed|Illumination:projectred.illumination.lamp — NOT the normal
# 0-15 lamps, which really aren't registered) via its own source, LightMicroMaterial.register()
# in https://github.com/GTNewHorizons/ProjectRed/blob/master/src/main/scala/mrtjp/projectred/illumination/lightmicroblocks.scala
# So a cfg miss is genuinely ambiguous: Et Futurum's concrete really isn't sawable (confirmed
# in-game — it also doesn't show up as a choosable material on the real saw), but a cfg miss
# for an FMP-sibling mod can be a false negative. There's no dynamic way to tell them apart —
# self-registration happens in that mod's own Java/Scala, nothing on disk records it — so this
# stays a small, explicitly-cited exception list (SELF_REGISTERING_PREFIXES) rather than a
# heuristic: `fmp_sawable_import` treats a cfg hit as reliably true and leaves a registry it
# recognizes here unchecked on a miss instead of guessing false; anything else missing from the
# cfg is marked false, same tradeoff microblocks.cfg itself makes. Absent (has_sawable_info
# false) means "never checked or ambiguous", not "confirmed not sawable" — nothing warns until
# the user actually imports a microblocks.cfg, and the warning text says "as far as the
# modpack's config tells us" rather than asserting it outright.
const KEY_SAWABLE := "fmp.sawable"

# Registry prefixes known — from the cited real source above, never guessed — to self-register
# some of their own materials with FMP outside config/microblocks.cfg. fmp_sawable_import
# leaves these unchecked on a whitelist miss instead of marking them false. Add an entry only
# against confirmed source (a real registerMaterial call), the same standard as everything else
# in this file, with a comment citing it exactly like the one above.
const SELF_REGISTERING_PREFIXES: PackedStringArray = ["ProjRed|Illumination:"]

static func is_self_registering(registry: String) -> bool:
	for prefix in SELF_REGISTERING_PREFIXES:
		if registry.begins_with(prefix):
			return true
	return false

static func has_sawable_info(bt: BlockType) -> bool:
	return bt != null and bt.metadata.has(KEY_SAWABLE)

static func is_sawable(bt: BlockType) -> bool:
	return bool(bt.metadata.get(KEY_SAWABLE, false)) if bt != null else false

static func mark_sawable(bt: BlockType, sawable: bool) -> void:
	bt.metadata[KEY_SAWABLE] = sawable

# A one-line warning if `bt` is a confirmed-not-sawable material being cut with a microblock
# shape (never for an architecture shape — those don't go through FMP at all), else "".
static func material_warning(bt: BlockType, shape_id: String) -> String:
	if bt == null or not ShapeCatalog.has(shape_id) or ShapeCatalog.family_of(shape_id) == ShapeCatalog.Family.ARCH:
		return ""
	if not has_sawable_info(bt) or is_sawable(bt):
		return ""
	return "isn't in the modpack's microblocks.cfg whitelist, as far as fmp_sawable_import could tell — parts cut from it may render as missing texture in-game (verify on the real saw if unsure; a few FMP-sibling mods self-register materials the cfg never lists)"

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
