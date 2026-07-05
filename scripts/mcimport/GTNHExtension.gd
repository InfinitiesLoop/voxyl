class_name GTNHExtension
extends MCImportExtension

# The GT New Horizons "pack" healer: one extension covering the several mods in the pack whose
# blocks the neutral flat import can't model well. Registered once, it declares the namespaces it
# handles (`_MODS`) and routes heal() to the right per-mod logic. Two kinds of fix:
#
#   • Shared "overlay junk" strip (every GT-family namespace) — the pack's mods reuse GregTech's
#     texture conventions, so they all litter the import with transparent single-purpose overlays
#     that are useless as standalone building blocks: emissive `_GLOW` layers, pipe ARROW_* /
#     PIPE_RESTRICTOR_* glyphs, fluid/item I/O `_SIGN`s, and cover overlays. Those are deleted.
#   • GregTech machines + tier casings — rebuilt from the hull + overlay pieces and named from
#     the pack's own GregTech.lang (see the gregtech section below).
#
# All pack knowledge lives here; the core import pipeline stays mod-agnostic (principle 4). Adding
# another mod = add its namespace to `_MODS` (shared junk strip applies automatically) and, if it
# needs bespoke healing, a branch in heal().

# Namespaces this pack handles. gregtech gets full healing + the junk strip; the GT-family addons
# (which share GregTech's texture conventions) get the junk strip only, for now.
const _MODS := {
	"gregtech": true,
	"ggfab": true,
}

func handles(ns: String) -> bool:
	return _MODS.has(ns)

func heal(ctx: MCHealContext) -> void:
	if ctx.ns == "gregtech":
		_heal_gregtech(ctx)
	_strip_overlay_junk(ctx)

# ---------------------------------------------------------------------------
# Shared: strip transparent "overlay junk" the flat import turned into blocks.
# ---------------------------------------------------------------------------

# Delete every presumptive block whose texture(s) are all single-purpose GT overlays — never a
# building block. Matched on the texture leaf name so it's independent of subdir/namespace:
#   *_GLOW               emissive layer (BOILER_FRONT_GLOW, DIESEL_GENERATOR_TOP_GLOW, …)
#   ARROW_* / PIPE_RESTRICTOR_*   pipe routing glyphs
#   *_SIGN               fluid/item I/O markers (FLUID_IN_SIGN, ITEM_OUT_SIGN, …)
#   OVERLAY_SHUTTER / OVERLAY_COVER* / COVER_* / ENDERFLUIDLINK_OVERLAY   cover overlays
# A block keeps its place if any texture isn't junk, so a real block that merely reuses one of
# these as an accent survives. Healed blocks (model id ".../heal/…") are never touched.
func _strip_overlay_junk(ctx: MCHealContext) -> void:
	for bt in ctx.library.block_types.duplicate():
		if bt.model_id.contains(":heal/"):
			continue
		var tex := ctx.block_texture_ids(bt)
		if tex.is_empty():
			continue
		var all_junk := true
		for tid in tex:
			if not _leaf_is_junk(str(tid).get_file()):
				all_junk = false
				break
		if all_junk:
			ctx.remove_block(bt.name)

func _leaf_is_junk(leaf: String) -> bool:
	return leaf.ends_with("_GLOW") \
		or leaf.begins_with("ARROW_") \
		or leaf.contains("PIPE_RESTRICTOR") \
		or leaf.ends_with("_SIGN") \
		or leaf.begins_with("OVERLAY_SHUTTER") \
		or leaf.begins_with("OVERLAY_COVER") \
		or leaf.begins_with("COVER_") \
		or leaf == "ENDERFLUIDLINK_OVERLAY"

# ===========================================================================
# GregTech — machines + tier casings.
#
# GregTech (1.7.10) has no model/blockstate JSON and composites a machine's look in Java from an
# opaque voltage HULL (iconsets/MACHINE_<TIER>_{SIDE,TOP,BOTTOM}) + a TRANSPARENT overlay per
# machine (basicmachines/<machine>/OVERLAY_<FACE>[_ACTIVE]), so the flat import yields invisible
# overlay cubes + cryptic `iconsets/machine_lv` hull cubes. This rebuilds the composite the
# renderer would draw, names it from GregTech.lang (keyed by the same folder name — e.g.
# gt.blockmachines.basicmachine.bender.tier.01.name = Basic Bending Machine), tags it for search,
# and removes the superseded presumptive cubes.
# ===========================================================================

# Texture-ref prefixes as the flat importer wrote them ("<ns>:<subdir>/<path>"). The `blocks`
# segment is the pre-1.8 `textures/blocks/` folder MCFlatImporter reads from.
const _ICONSETS := "gregtech:blocks/iconsets"
const _BASICMACHINES := "gregtech:blocks/basicmachines"
const _MACHINES_TEX_DIR := "gregtech/textures/blocks/basicmachines"

# Voltage tiers a basic machine spans, tier.01 first (GT5 basic machines start at LV). Case
# matches the texture filenames — MACHINE_LuV_SIDE is mixed-case, not MACHINE_LUV_SIDE.
const _MACHINE_TIERS := ["LV", "MV", "HV", "EV", "IV", "LuV", "ZPM", "UV", "UHV", "UEV", "UIV", "UMV"]
# Tier casings additionally include ULV (gt.blockcasings.0.name = ULV Machine Casing).
const _CASING_TIERS := ["ULV", "LV", "MV", "HV", "EV", "IV", "LuV", "ZPM", "UV", "UHV", "UEV", "UIV"]

# Texture folder → GregTech.lang machine key, for the handful that don't match after
# normalizing (the lang abbreviates "electric" to "e"). Everything else matches once
# underscores are stripped (alloy_smelter ↔ alloysmelter).
const _FOLDER_ALIAS := {
	"electric_furnace": "e_furnace",
	"electric_oven": "e_oven",
}

func _heal_gregtech(ctx: MCHealContext) -> void:
	var names := _parse_machine_names(ctx)
	_heal_casings(ctx)
	_heal_machines(ctx, names)
	_remove_superseded(ctx)

# ---------------------------------------------------------------------------
# Tier machine casings: MACHINE_<TIER>_{SIDE,TOP,BOTTOM} → "<TIER> Machine Casing".
# ---------------------------------------------------------------------------

func _heal_casings(ctx: MCHealContext) -> void:
	for tier in _CASING_TIERS:
		var side := "%s/MACHINE_%s_SIDE" % [_ICONSETS, tier]
		if not ctx.source_has_texture(side):
			continue
		var faces := _hull_faces(ctx, tier)
		if faces.is_empty():
			continue
		var color := _avg(ctx, faces[BlockModel.Dir.NORTH])
		var name := ctx.unique_name("%s Machine Casing" % tier)
		ctx.add_cube(name, faces, color,
			PackedStringArray(["casing", "machine", tier.to_lower()]))

# The six-face binding for a tier's plain hull (verbatim textures, no overlay): SIDE on the
# four horizontals, TOP/BOTTOM on the caps. {} if the side hull can't be read.
func _hull_faces(ctx: MCHealContext, tier: String) -> Dictionary:
	var s := ctx.ensure_texture("%s/MACHINE_%s_SIDE" % [_ICONSETS, tier])
	if s == null:
		return {}
	var t := ctx.ensure_texture("%s/MACHINE_%s_TOP" % [_ICONSETS, tier])
	var b := ctx.ensure_texture("%s/MACHINE_%s_BOTTOM" % [_ICONSETS, tier])
	var top_id: String = t.id if t != null else s.id
	var bot_id: String = b.id if b != null else s.id
	return {
		BlockModel.Dir.NORTH: s.id, BlockModel.Dir.EAST: s.id,
		BlockModel.Dir.SOUTH: s.id, BlockModel.Dir.WEST: s.id,
		BlockModel.Dir.UP: top_id, BlockModel.Dir.DOWN: bot_id,
	}

# ---------------------------------------------------------------------------
# Machines: overlay + hull → a named, composited cube per tier (+ an Active variant).
# ---------------------------------------------------------------------------

func _heal_machines(ctx: MCHealContext, names: Dictionary) -> void:
	for folder in _machine_folders(ctx):
		var tiers := _tiers_for(folder, names)
		for tier_idx in tiers:
			if tier_idx < 1 or tier_idx > _MACHINE_TIERS.size():
				continue
			var tier: String = _MACHINE_TIERS[tier_idx - 1]
			var display: String = tiers[tier_idx]
			_emit_machine(ctx, folder, tier, display, false)
			_emit_machine(ctx, folder, tier, display, true)

# One machine block: composite each face's overlay over the tier hull and bind a cube. `active`
# builds the running variant from the `_ACTIVE` overlays (skipped when the machine has none).
func _emit_machine(ctx: MCHealContext, folder: String, tier: String, display: String, active: bool) -> void:
	if active and not ctx.source_has_texture("%s/%s/OVERLAY_FRONT_ACTIVE" % [_BASICMACHINES, folder]):
		return
	var out_base := "gregtech:heal/%s_%s%s" % [folder, tier.to_lower(), "_active" if active else ""]
	var front := _face_tex(ctx, out_base + "/front", tier, folder, "FRONT", active)
	var side := _face_tex(ctx, out_base + "/side", tier, folder, "SIDE", active)
	var top := _face_tex(ctx, out_base + "/top", tier, folder, "TOP", active)
	var bottom := _face_tex(ctx, out_base + "/bottom", tier, folder, "BOTTOM", active)
	if front.is_empty() and side.is_empty():
		return   # nothing to show for this machine at this tier
	# Resting facing NORTH: front on -Z, the same side texture on the other three horizontals.
	var lateral := side if not side.is_empty() else front
	var faces := {
		BlockModel.Dir.NORTH: front if not front.is_empty() else lateral,
		BlockModel.Dir.EAST: lateral, BlockModel.Dir.SOUTH: lateral, BlockModel.Dir.WEST: lateral,
		BlockModel.Dir.UP: top if not top.is_empty() else lateral,
		BlockModel.Dir.DOWN: bottom if not bottom.is_empty() else lateral,
	}
	var color := _avg(ctx, faces[BlockModel.Dir.NORTH])
	var name := ctx.unique_name("%s (Active)" % display if active else display)
	var tags := PackedStringArray(["machine", folder, tier.to_lower()])
	if active:
		tags.append("active")
	ctx.add_cube(name, faces, color, tags)

# The composited texture id for one face, or "": overlay-over-hull when the overlay exists
# (falling back to the idle overlay for an Active face a machine doesn't animate), else the
# plain hull. Hull SIDE backs the front + sides; TOP/BOTTOM back the caps.
func _face_tex(ctx: MCHealContext, out_id: String, tier: String, folder: String, face: String, active: bool) -> String:
	var hull := "%s/MACHINE_%s_%s" % [_ICONSETS, tier, "TOP" if face == "TOP" else ("BOTTOM" if face == "BOTTOM" else "SIDE")]
	if not ctx.source_has_texture(hull):
		hull = ""   # no hull for this tier → composite over a neutral base
	var overlay := "%s/%s/OVERLAY_%s%s" % [_BASICMACHINES, folder, face, "_ACTIVE" if active else ""]
	if active and not ctx.source_has_texture(overlay):
		overlay = "%s/%s/OVERLAY_%s" % [_BASICMACHINES, folder, face]   # this face doesn't animate
	if ctx.source_has_texture(overlay):
		var asset := ctx.composite_texture(out_id, hull, overlay)
		return asset.id if asset != null else ""
	if not hull.is_empty():
		var h := ctx.ensure_texture(hull)
		return h.id if h != null else ""
	return ""

# The machine subfolders under textures/blocks/basicmachines (each is one machine's overlays).
func _machine_folders(ctx: MCHealContext) -> Array:
	var seen := {}
	for rel in ctx.source.list_files_recursive(_MACHINES_TEX_DIR):
		var slash := rel.find("/")
		if slash > 0:
			seen[rel.substr(0, slash)] = true
	var out := seen.keys()
	out.sort()
	return out

# {tier_index → display name} for a machine: from GregTech.lang when its folder maps to a lang
# entry, else a derived "<Pretty Folder> (<TIER>)" for every tier (so an import without the
# instance lang still yields usable, if generic, names).
func _tiers_for(folder: String, names: Dictionary) -> Dictionary:
	var key := _lang_key_for(folder, names)
	if not key.is_empty():
		return names[key]
	var pretty := _prettify(folder)
	var out := {}
	for i in _MACHINE_TIERS.size():
		out[i + 1] = "%s (%s)" % [pretty, _MACHINE_TIERS[i]]
	return out

func _lang_key_for(folder: String, names: Dictionary) -> String:
	var norm := _norm(folder)
	if names.has(norm):
		return norm
	if _FOLDER_ALIAS.has(folder):
		var aliased := _norm(_FOLDER_ALIAS[folder])
		if names.has(aliased):
			return aliased
	return ""

# ---------------------------------------------------------------------------
# GregTech.lang parsing (the display names, keyed by machine folder + tier index)
# ---------------------------------------------------------------------------

# norm(folder) → { tier_index:int → display:String } from the instance-level GregTech.lang.
# The keys look like `S:gt.blockmachines.basicmachine.<folder>.tier.<NN>.name=<Display>`.
func _parse_machine_names(ctx: MCHealContext) -> Dictionary:
	var text := ctx.read_sibling_text("GregTech.lang")
	var out := {}
	if text.is_empty():
		ctx.warnings.append(
			"gregtech: GregTech.lang not found near the import source — machines named generically")
		return out
	const PREFIX := "gt.blockmachines.basicmachine."
	for raw in text.split("\n"):
		var line := raw.strip_edges()
		var eq := line.find("=")
		if eq < 0:
			continue
		var key := line.substr(0, eq).strip_edges()
		if key.begins_with("S:"):
			key = key.substr(2)
		if not key.begins_with(PREFIX) or not key.ends_with(".name"):
			continue
		var mid := key.substr(PREFIX.length())          # "<folder>.tier.<NN>.name"
		var ti := mid.find(".tier.")
		if ti < 0:
			continue
		var folder := mid.substr(0, ti)
		var after := mid.substr(ti + 6)                 # ".tier." is 6 chars → "<NN>.name"
		var dot := after.find(".")
		var tier_str := after.substr(0, dot) if dot >= 0 else after
		if not tier_str.is_valid_int():
			continue
		var display := line.substr(eq + 1).strip_edges()
		var norm := _norm(folder)
		if not out.has(norm):
			out[norm] = {}
		out[norm][int(tier_str)] = display
	return out

# ---------------------------------------------------------------------------
# Remove the presumptive cubes this heal supersedes.
# ---------------------------------------------------------------------------

# Drop every presumptive block whose model is built ENTIRELY from basicmachines/ overlays or
# from a tier hull face — the transparent overlay cubes and the raw `iconsets/machine_lv` hulls
# we've now replaced with composited, named machines/casings. Blocks that also use other
# textures (the named structural casings like COKE_OVEN_CASING) are left untouched.
func _remove_superseded(ctx: MCHealContext) -> void:
	var hull_ids := {}
	for tier in _CASING_TIERS:
		for face in ["SIDE", "TOP", "BOTTOM"]:
			hull_ids["%s/MACHINE_%s_%s" % [_ICONSETS, tier, face]] = true
	var overlay_prefix := _BASICMACHINES + "/"
	for bt in ctx.library.block_types.duplicate():
		if bt.model_id.begins_with("gregtech:heal/"):
			continue   # never remove what we just added
		var tex := ctx.block_texture_ids(bt)
		if tex.is_empty():
			continue
		var superseded := true
		for tid in tex:
			var s := str(tid)
			if not (s.begins_with(overlay_prefix) or hull_ids.has(s)):
				superseded = false
				break
		if superseded:
			ctx.remove_block(bt.name)

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

func _avg(ctx: MCHealContext, tex_id: String) -> Color:
	if tex_id.is_empty():
		return Color(0.5, 0.5, 0.5)
	var a := ctx.library.get_texture_asset(tex_id)
	return a.average_color if a != null else Color(0.5, 0.5, 0.5)

func _norm(s: String) -> String:
	return s.replace("_", "").to_lower()

func _prettify(folder: String) -> String:
	return folder.replace("_", " ").capitalize()
