class_name McId
extends RefCounted

# The well-known BlockType.metadata keys the Schematica extension (this folder,
# NeiRosterImporter) reads and writes, and their accessors — every other file touches this
# data only through these, never with raw dictionary keys. BlockType itself stays generic
# (see BlockType.metadata's doc comment); nothing here is core, and core never depends on it.
#
# "mc.registry" is Minecraft's own FML registry name ("minecraft:stone",
# "Ztones:tile.korpBlock", "gregtech:gt.blockmachines") — the identity whole-block Schematica
# export, ForgeMultipart's microblock "material" field, and ArchitectureCraft's BaseName/Name2
# all use (confirmed against BlockMicroMaterial.materialKey and TileShape's own save code —
# FMP's per-microblock "material" string is just this registry name, with "_<meta>" appended
# for a non-zero meta; there is no separate FMP-only identity to track).
# "mc.meta" is the data value alongside that registry name. For a GT single-block machine this
# is its mID (can exceed 15 — GT stores it in the tile entity, never the block's own meta;
# NeiRosterImporter's confirmed meta value from the Item Panel dump is exactly this number).
# "mc.orient" is the whole-block orientation family SchematicaMeta applies over mc.meta:
# "" (fixed, used as-is) | "half" | "stairs" | "log_axis".
# "mc.mod" / "mc.display" are the owning mod id and NEI's own display name — searchable, not
# needed for export itself.
# "mc.confirmed" is true when an identity came straight from a real registry dump
# (NeiRosterImporter) rather than a manual/typed correction.

const KEY_REGISTRY := "mc.registry"
const KEY_META := "mc.meta"
const KEY_ORIENT := "mc.orient"
const KEY_MOD := "mc.mod"
const KEY_DISPLAY := "mc.display"
const KEY_CONFIRMED := "mc.confirmed"

# mc.orient values.
const ORIENT_NONE := ""
const ORIENT_HALF := "half"
const ORIENT_STAIRS := "stairs"
const ORIENT_LOG_AXIS := "log_axis"

static func get_registry(bt: BlockType) -> String:
	return str(bt.metadata.get(KEY_REGISTRY, "")) if bt != null else ""

# Named get_mc_meta, not get_meta — Object already defines a get_meta(StringName) for its own
# generic metadata system, and GDScript rejects a static override with a different signature.
static func get_mc_meta(bt: BlockType) -> int:
	return int(bt.metadata.get(KEY_META, 0)) if bt != null else 0

static func get_orient(bt: BlockType) -> String:
	return str(bt.metadata.get(KEY_ORIENT, "")) if bt != null else ""

static func get_mod(bt: BlockType) -> String:
	return str(bt.metadata.get(KEY_MOD, "")) if bt != null else ""

static func get_display(bt: BlockType) -> String:
	return str(bt.metadata.get(KEY_DISPLAY, "")) if bt != null else ""

static func is_confirmed(bt: BlockType) -> bool:
	return bool(bt.metadata.get(KEY_CONFIRMED, false)) if bt != null else false

static func has_registry(bt: BlockType) -> bool:
	return not get_registry(bt).is_empty()

# Set the whole-block / ArchitectureCraft identity (registry name + meta + orientation
# family). An empty registry clears it. `mod`/`display` are optional search aids.
static func set_registry_id(bt: BlockType, registry: String, meta: int = 0, orient: String = ORIENT_NONE,
		confirmed: bool = false, mod: String = "", display: String = "") -> void:
	if registry.is_empty():
		bt.metadata.erase(KEY_REGISTRY)
		bt.metadata.erase(KEY_ORIENT)
	else:
		bt.metadata[KEY_REGISTRY] = registry
		bt.metadata[KEY_META] = meta
		if orient.is_empty():
			bt.metadata.erase(KEY_ORIENT)
		else:
			bt.metadata[KEY_ORIENT] = orient
	if not mod.is_empty():
		bt.metadata[KEY_MOD] = mod
	if not display.is_empty():
		bt.metadata[KEY_DISPLAY] = display
	bt.metadata[KEY_CONFIRMED] = confirmed

# The FMP microblock "material" NBT string (see ForgeMultipart's BlockMicroMaterial.materialKey):
# mc.registry, with "_<meta>" appended when meta > 0. "" when mc.registry isn't set.
static func fmp_material_key(bt: BlockType) -> String:
	var registry := get_registry(bt)
	if registry.is_empty():
		return ""
	var meta := get_mc_meta(bt)
	return "%s_%d" % [registry, meta] if meta > 0 else registry
