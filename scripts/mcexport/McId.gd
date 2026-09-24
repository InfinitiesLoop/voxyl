class_name McId
extends RefCounted

# The well-known BlockType.metadata keys the Schematica extension (this folder,
# NeiRosterImporter) reads and writes, and their accessors — every other file touches this
# data only through these, never with raw dictionary keys. BlockType itself stays generic
# (see BlockType.metadata's doc comment); nothing here is core, and core never depends on it.
#
# "mc.registry" is Minecraft's own FML registry name ("minecraft:stone",
# "Ztones:tile.korpBlock", "gregtech:gt.blockmachines") — the identity whole-block Schematica
# export and ArchitectureCraft's BaseName/Name2 both use.
# "mc.meta" is the data value alongside that registry name. For a GT single-block machine this
# is its mID (can exceed 15 — GT stores it in the tile entity, never the block's own meta;
# NeiRosterImporter's confirmed meta value from the Item Panel dump is exactly this number).
# "mc.unlocalized" is a *different* identity string (e.g. "tile.wool") that ForgeMultipart's
# microblock "material" field uses instead of the registry name (confirmed from its own source,
# BlockMicroMaterial.materialKey — not guessed). NEI's dumps don't expose unlocalized names, so
# this one typically needs a manual block_set_mc_id call, only for blocks actually used as
# microblock/cover material.
# "mc.orient" is the whole-block orientation family SchematicaMeta applies over mc.meta:
# "" (fixed, used as-is) | "half" | "stairs" | "log_axis".
# "mc.mod" / "mc.display" are the owning mod id and NEI's own display name — searchable, not
# needed for export itself.
# "mc.confirmed" is true when an identity came straight from a real registry dump
# (NeiRosterImporter) rather than a manual/typed correction.

const KEY_REGISTRY := "mc.registry"
const KEY_META := "mc.meta"
const KEY_UNLOCALIZED := "mc.unlocalized"
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

static func get_unlocalized(bt: BlockType) -> String:
	return str(bt.metadata.get(KEY_UNLOCALIZED, "")) if bt != null else ""

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

static func has_unlocalized(bt: BlockType) -> bool:
	return not get_unlocalized(bt).is_empty()

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

# Set the ForgeMultipart microblock material identity (unlocalized name + meta). Independent
# of set_registry_id — a block type may need either or both depending on how it's placed.
static func set_unlocalized_id(bt: BlockType, unlocalized: String, meta: int = 0, confirmed: bool = false) -> void:
	if unlocalized.is_empty():
		bt.metadata.erase(KEY_UNLOCALIZED)
	else:
		bt.metadata[KEY_UNLOCALIZED] = unlocalized
		bt.metadata[KEY_META] = meta
	bt.metadata[KEY_CONFIRMED] = confirmed

# The FMP "material" NBT string (see ForgeMultipart's BlockMicroMaterial.materialKey): the
# unlocalized name, with "_<meta>" appended when meta > 0. "" when mc.unlocalized isn't set.
static func fmp_material_key(bt: BlockType) -> String:
	var name := get_unlocalized(bt)
	if name.is_empty():
		return ""
	var meta := get_mc_meta(bt)
	return "%s_%d" % [name, meta] if meta > 0 else name
