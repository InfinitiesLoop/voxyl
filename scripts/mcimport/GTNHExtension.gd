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
	"etfuturum": true,
	"catwalks": true,
	"chisel": true,
	"ProjRed|Illumination": true,
	"ExtraUtilities": true,
	"Ztones": true,
}

# Namespaces handled only for the attachment flags below: no healing, no junk strip.
const _ATTACH_ONLY := {
	"minecraft": true,
	"GalacticraftCore": true,
	"BloodArsenal": true,
}

# Blocks that hold on to a neighbour the way a vanilla torch does (stand on the block below, or
# lean out of a wall) whose textures are a torch in vanilla's layout but which the flat import
# could only draw as a cube. Matched by registry name. Flagging one (BlockType.attachment) gives
# it real torch geometry, placement and rotation, and makes Schematica export write vanilla's
# torch metadata, which these all inherit from BlockTorch; add a mod's torch here once you know
# it does. (Magnum Torch is deliberately absent: a chunky custom model, not a vanilla torch.)
const _TORCHES := [
	"minecraft:torch", "minecraft:redstone_torch", "minecraft:unlit_redstone_torch",
	"etfuturum:soul_torch",
	"GalacticraftCore:tile.glowstoneTorch",
	"BloodArsenal:blood_torch",
]

func handles(ns: String) -> bool:
	return _MODS.has(ns) or _ATTACH_ONLY.has(ns)

func heal(ctx: MCHealContext) -> void:
	if _ATTACH_ONLY.has(ctx.ns):
		_flag_attachments(ctx)
		return
	_flag_attachments(ctx)
	if ctx.ns == "gregtech":
		_heal_gregtech(ctx)
	elif ctx.ns == "etfuturum":
		_heal_etfuturum(ctx)
	elif ctx.ns == "catwalks":
		_heal_catwalks(ctx)
	elif ctx.ns == "chisel":
		_heal_chisel(ctx)
	elif ctx.ns == "ProjRed|Illumination":
		_heal_projred_illumination(ctx)
	elif ctx.ns == "ExtraUtilities":
		_heal_extrautilities(ctx)
	elif ctx.ns == "Ztones":
		_heal_ztones(ctx)
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
func _flag_attachments(ctx: MCHealContext) -> void:
	for bt in ctx.library.block_types:
		if bt.attachment.is_empty() and _TORCHES.has(McId.get_registry(bt)):
			bt.attachment = Attachment.TORCH

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

# Texture-ref prefixes in MCTexImport's "<ns>:<subdir>/<path>" convention. The `blocks`
# segment is the pre-1.8 `textures/blocks/` folder GTNH's assets keep their PNGs under.
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

# ===========================================================================
# EtFuturum — vanilla-backport block families the flat import's meta matching can't reach.
#
# EtFuturum restores several post-1.7.10 vanilla block families into GTNH, each as ONE
# registry name with 16 packed metas (mirroring vanilla's own metadata scheme) — but ships
# every meta's texture as its own color-PREFIXED file (gray_concrete.png, white_concrete.png)
# rather than the base-name-then-suffix shape the generic importer's meta matching looks for
# (concrete_7.png, korp_ (4).png: NeiRosterImporter._matches_base requires the registry's own
# token(s) to come FIRST). So every meta of etfuturum:concrete / concrete_powder fails to
# match anything and the whole 32-block family (confirmed against the pack's real GTNH 2.9
# NEI dump) is silently dropped. This binds each meta straight to its own file by color name.
# The color order is vanilla's own dye/wool metadata order, also confirmed against the dump.
# ===========================================================================

const _DYE_COLORS := [
	"white", "orange", "magenta", "light_blue", "yellow", "lime", "pink", "gray",
	"light_gray", "cyan", "purple", "blue", "brown", "green", "red", "black",
]

func _heal_etfuturum(ctx: MCHealContext) -> void:
	_heal_color_packed(ctx, "etfuturum:concrete", "%s_concrete", "%s Concrete")
	_heal_color_packed(ctx, "etfuturum:concrete_powder", "%s_concrete_powder", "%s Concrete Powder")

# A meta-packed registry whose 16 vanilla-dye-ordered variants each have their own
# color-prefixed texture file under vanilla's shared "minecraft" domain (see class doc) —
# one confirmed, uniformly-textured cube per meta. `file_fmt`/`display_fmt` take the color
# name ("light_blue"); reusable for any other EtFuturum family shaped the same way.
func _heal_color_packed(ctx: MCHealContext, registry: String, file_fmt: String, display_fmt: String) -> void:
	for meta in _DYE_COLORS.size():
		var color_name: String = _DYE_COLORS[meta]
		var ref := "minecraft:blocks/%s" % (file_fmt % color_name)
		if not ctx.source_has_texture(ref):
			continue
		var tex := ctx.ensure_texture(ref)
		if tex == null:
			continue
		var display := display_fmt % color_name.capitalize()
		var faces := {
			BlockModel.Dir.UP: tex.id, BlockModel.Dir.DOWN: tex.id,
			BlockModel.Dir.NORTH: tex.id, BlockModel.Dir.SOUTH: tex.id,
			BlockModel.Dir.EAST: tex.id, BlockModel.Dir.WEST: tex.id,
		}
		var bt := ctx.add_cube(_stable_name(ctx, registry, meta, display), faces, tex.average_color,
			PackedStringArray(["etfuturum"]))
		ctx.confirm_registry(bt, registry, meta, "etfuturum", display)

# ===========================================================================
# Catwalks — thin platform/rail/ladder blocks, critical to a GTNH build, whose per-item
# textures sit several state-folders deep (lit/tape/nobottom for the catwalk + caged-ladder
# families) that the flat importer's suffix matching can't peel through; of the pack's own
# nine placeable roster rows for this mod (item.csv cross-referenced against itempanel.csv —
# most of the mod's 40+ registry names are unplaceable pure block-states, e.g. the "_lit"/
# "_tape" catwalk variants), only "Scaffold" survives unaided (its two files sit flat under
# textures/blocks/, matching the generic face-suffix path). This binds the other eight by
# hand to their plain (unlit/untaped) textures.
#
# NOT a faithful reproduction of the mod's real non-cube geometry — rails, ladders and
# catwalks aren't cubes in-game, and voxyl has no shape for them yet. This gives each a
# recognizable, correctly-colored, correctly-export-identified cube stand-in, same spirit as
# the GregTech machine cubes above; a real thin-platform/rail SHAPE is future work, not this.
# ===========================================================================

const _CATWALKS_TEX := "catwalks:blocks"

func _heal_catwalks(ctx: MCHealContext) -> void:
	_heal_catwalks_uniform(ctx, "catwalks:sturdy_rail", 0, "Sturdy Rail", "sturdy_rail/normal")
	_heal_catwalks_uniform(ctx, "catwalks:sturdy_rail_powered", 0, "Sturdy Powered Rail", "sturdy_rail/booster_off")
	_heal_catwalks_uniform(ctx, "catwalks:sturdy_rail_detector", 0, "Sturdy Detector Rail", "sturdy_rail/detector_off")
	_heal_catwalks_uniform(ctx, "catwalks:sturdy_rail_activator", 0, "Sturdy Activator Rail", "sturdy_rail/activator_off")
	_heal_catwalks_uniform(ctx, "catwalks:support_column", 0, "Support Column", "support")
	_heal_catwalks_faces(ctx, "catwalks:scaffold", 1, "Builder's Scaffold", {
		BlockModel.Dir.UP: "scaffold_builders_top", BlockModel.Dir.DOWN: "scaffold_builders_top",
		BlockModel.Dir.NORTH: "scaffold_builders_side", BlockModel.Dir.SOUTH: "scaffold_builders_side",
		BlockModel.Dir.EAST: "scaffold_builders_side", BlockModel.Dir.WEST: "scaffold_builders_side",
	})
	_heal_catwalks_faces(ctx, "catwalks:catwalk_unlit", 0, "Catwalk", {
		BlockModel.Dir.UP: "transparent",
		BlockModel.Dir.DOWN: "catwalk/bottom/plain/no_lights",
		BlockModel.Dir.NORTH: "catwalk/side/plain/no_lights", BlockModel.Dir.SOUTH: "catwalk/side/plain/no_lights",
		BlockModel.Dir.EAST: "catwalk/side/plain/no_lights", BlockModel.Dir.WEST: "catwalk/side/plain/no_lights",
	})
	# "Tape" isn't a texture swap on the same block — the pack's own NEI dump (block.csv)
	# registers it as its own block, "catwalks:catwalk_unlit_tape", a real block ID (3101)
	# distinct from plain catwalk_unlit (3102). No item backs it (nothing crafts an
	# already-taped catwalk — the tape is applied in-world), so it never surfaces in the
	# roster's placeable/item-backed listing, but it's a genuine confirmable registry+meta for
	# export all the same. Public source (thecodewarrior/Catwalk-Mod, GTNH's likely base)
	# stores render state on the TileEntity rather than exposing a model here, so meta 0 (the
	# block's only placeable state) is the safe default, same as every other catwalks entry.
	_heal_catwalks_faces(ctx, "catwalks:catwalk_unlit_tape", 0, "Catwalk (Tape)", {
		BlockModel.Dir.UP: "transparent",
		BlockModel.Dir.DOWN: "catwalk/bottom/tape/no_lights",
		BlockModel.Dir.NORTH: "catwalk/side/tape/no_lights", BlockModel.Dir.SOUTH: "catwalk/side/tape/no_lights",
		BlockModel.Dir.EAST: "catwalk/side/tape/no_lights", BlockModel.Dir.WEST: "catwalk/side/tape/no_lights",
	})
	_heal_catwalks_faces(ctx, "catwalks:cagedLadder_north_unlit", 0, "Caged Ladder", {
		BlockModel.Dir.UP: "ladder/side/plain/no_lights", BlockModel.Dir.DOWN: "ladder/bottom/plain/no_lights",
		BlockModel.Dir.NORTH: "ladder/front/plain/no_lights", BlockModel.Dir.SOUTH: "ladder/ladder/plain/no_lights",
		BlockModel.Dir.EAST: "ladder/side/plain/no_lights", BlockModel.Dir.WEST: "ladder/side/plain/no_lights",
	})

# The same single texture on all six faces — a plain material stand-in for an item with no
# meaningful per-face variation available (a rail overlay, a support post).
func _heal_catwalks_uniform(ctx: MCHealContext, registry: String, meta: int, display: String,
		tex_path: String) -> void:
	_heal_catwalks_faces(ctx, registry, meta, display, {
		BlockModel.Dir.UP: tex_path, BlockModel.Dir.DOWN: tex_path,
		BlockModel.Dir.NORTH: tex_path, BlockModel.Dir.SOUTH: tex_path,
		BlockModel.Dir.EAST: tex_path, BlockModel.Dir.WEST: tex_path,
	})

# One confirmed, per-face-textured cube. `dir_to_path` values are relative to
# textures/blocks/ (no namespace/subdir prefix, no extension). Skips (with a warning) if any
# named face's file is missing, rather than binding a partially-textured block.
func _heal_catwalks_faces(ctx: MCHealContext, registry: String, meta: int, display: String,
		dir_to_path: Dictionary) -> void:
	var faces := {}
	for d in dir_to_path:
		var ref := "%s/%s" % [_CATWALKS_TEX, dir_to_path[d]]
		var tex := ctx.ensure_texture(ref)
		if tex == null:
			ctx.warnings.append("catwalks: missing texture %s for %s, skipped" % [ref, display])
			return
		faces[d] = tex.id
	var bt := ctx.add_cube(_stable_name(ctx, registry, meta, display), faces, _avg(ctx, faces[BlockModel.Dir.NORTH]),
		PackedStringArray(["catwalks"]))
	ctx.confirm_registry(bt, registry, meta, "catwalks", display)

# ===========================================================================
# Chisel — ~75 decorative block families whose per-meta texture the flat import's token-prefix
# matching can never reach.
#
# Chisel (1.7.10, predates blockstate JSON) hardcodes its meta -> texture mapping in Java: each
# block group is registered via CarvableHelper.addVariation(descKey, meta, texturePath), and the
# texture path is an artist-chosen name with NO correlation to the registry name or a numeral
# suffix (chisel:glass meta 1 ships as "glass/terrain-glassbubble.png", meta 3 as
# "glass/japanese.png") — exactly the shape NeiRosterImporter._matches_base's token-prefix rule
# can't and shouldn't try to guess at (see that file's class doc). ChiselVariations.VARIATIONS is
# the ground truth for this — group -> {meta -> texture base name} — extracted once by decompiling
# every team.chisel.Features$N.class (one per block group) with javap and parsing its
# addVariation calls; see that file's header for how, and which groups it deliberately excludes as
# ambiguous (metalOre, voidstone, tallow).
#
# Resolving a base name to an actual file still needs a fallback chain, because Chisel's own
# texture folders aren't internally consistent either: most groups nest their files under
# "<group>/<name>.png" with the group already baked into the base name (checked as bare, then
# with an explicit "<group_lowercase>/" prefix for the groups that don't), and several sub-
# families (columns, pillars, some wall panels) ship a SIDE + TOP pair (foo-side.png/foo-top.png,
# or a "-ctmv"/"-ctmh" connected-texture variant of the side face) instead of one flat texture —
# confirmed against the pack's real GTNH 2.5.1 Chisel jar, which resolves ~97% of the extracted
# table this way; whatever's left (a few dozen truly one-off names) is dropped with a warning,
# same as any other unmatched roster row.
# ===========================================================================

const _CHISEL_TEX := "chisel:blocks"
const _CHISEL_SIDE_SUFFIXES := ["-side", "-ctmv", "-ctmh"]

# Groups that are real Minecraft panes/bars (glass_pane, iron_bars, and the 16 dyed
# stained_glass_pane_* families — see ChiselVariations' own comment on that family)
# rather than a decorative cube — these get PaneGeometry's real connecting geometry via
# _heal_chisel_pane instead of add_cube's full-block fallback. iron_bars reuses the same
# post/side/side_alt/noside/noside_alt shape real Minecraft's own bars_* models do — it's
# numerically the identical thin-band convention as a pane, just under a different name.
func _is_chisel_pane_group(group: String) -> bool:
	return group == "glass_pane" or group == "iron_bars" or group.begins_with("stained_glass_pane_")

func _heal_chisel(ctx: MCHealContext) -> void:
	var lang := _parse_chisel_lang(ctx)
	for group in ChiselVariations.VARIATIONS:
		var metas: Dictionary = ChiselVariations.VARIATIONS[group]
		var registry := "chisel:%s" % group
		var group_name: String = lang.get("chisel.%s" % group, _prettify(group))
		var is_pane := _is_chisel_pane_group(group)
		for meta in metas:
			var base: String = metas[meta]
			var display := _chisel_display(lang, group, group_name, int(meta))
			if is_pane:
				_heal_chisel_pane(ctx, registry, group, int(meta), base, display)
				continue
			var fake_controller: String = _CHISEL_FAKE_CONTROLLER_CROP.get(group, {}).get(int(meta), "")
			var faces := _chisel_icon_crop_faces(ctx, fake_controller) if not fake_controller.is_empty() \
				else _chisel_faces(ctx, group, base)
			if faces.is_empty():
				ctx.warnings.append(
					"chisel: no texture match for %s meta %d (%s), skipped" % [registry, meta, base])
				continue
			var color := _avg(ctx, faces[BlockModel.Dir.NORTH])
			var bt := ctx.add_cube(_stable_name(ctx, registry, int(meta), display), faces, color,
				PackedStringArray(["chisel", group.to_lower()]))
			ctx.confirm_registry(bt, registry, int(meta), "Chisel", display)

# A pane-shaped Chisel group, healed with PaneGeometry's real connecting geometry
# instead of a full cube. Chisel's own 1.7.10 pane renderer (team.chisel.block.
# BlockCarvablePane, predating blockstate JSON) already split most variants' look into
# the same two textures vanilla's later blockstate/model JSON pane formalized — a
# "side" (the flat visible face) and a "top" (the thin rim/end-cap) — so the same
# top/side resolution _chisel_pair uses for a cube column just needs to feed
# PaneGeometry instead of six cube faces. Not every variant ships a dedicated "-top"
# though (confirmed against the real jar: e.g. glass_pane's "Screen Pane" is one bare
# file, "glasspane/terrain-glass-screen", no top/side split at all) — those fall back
# to PaneGeometry's single-texture mode (the same file for both roles), same spirit as
# _chisel_faces' single-before-pair fallback for the cube path, just tried in the
# opposite order since a pane specifically benefits from a real dedicated rim texture
# when one's actually there.
func _heal_chisel_pane(ctx: MCHealContext, registry: String, group: String, meta: int,
		base: String, display: String) -> void:
	var side_tex: String
	var edge_tex: String
	var pair := _chisel_top_side(ctx, group, base)
	if not pair.is_empty():
		side_tex = pair["side"]
		edge_tex = pair["top"]
	else:
		side_tex = _chisel_single(ctx, group, base)
		edge_tex = side_tex
	if side_tex.is_empty():
		ctx.warnings.append(
			"chisel: no texture match for %s meta %d (%s), skipped" % [registry, meta, base])
		return
	var color := _avg(ctx, side_tex)
	var bt := ctx.add_pane(_stable_name(ctx, registry, meta, display), side_tex, edge_tex, color,
		PackedStringArray(["chisel", group.to_lower()]))
	ctx.confirm_registry(bt, registry, meta, "Chisel", display)

# The display name for one meta of a Chisel group — shared by the cube and pane heal
# paths.
func _chisel_display(lang: Dictionary, group: String, group_name: String, meta: int) -> String:
	var sgp_key := "SGP_DISPLAY:%s:%d" % [group, meta]
	if lang.has(sgp_key):
		return lang[sgp_key]   # stained_glass_pane_*: a real name even at meta 0 —
		                       # see _add_stained_glass_names
	if meta == 0:
		return group_name   # meta 0's .desc is often a tooltip, not a name (e.g.
		                     # "tile.andesite.0.desc=Generates in your world")
	return lang.get("%s.%d" % [group, meta], "%s %d" % [group_name, meta])

# All six faces bound to one texture, or UP/DOWN to a "top" face and the four horizontals to a
# "side" face for a column/pillar-shaped group — {} if neither resolves (see class doc for the
# fallback chain).
func _chisel_faces(ctx: MCHealContext, group: String, base: String) -> Dictionary:
	var single := _chisel_single(ctx, group, base)
	if not single.is_empty():
		return {
			BlockModel.Dir.UP: single, BlockModel.Dir.DOWN: single,
			BlockModel.Dir.NORTH: single, BlockModel.Dir.SOUTH: single,
			BlockModel.Dir.EAST: single, BlockModel.Dir.WEST: single,
		}
	return _chisel_pair(ctx, group, base)

# "futura" metas 2/4/5 (controller/controllerPurple/uberWavy) are registered through
# team.chisel.client.render.SubmapManagerFakeController, not a plain addVariation(String) or the
# top/side pair every other column-shaped group above uses. Confirmed straight from the
# decompiled Features$33.addBlocks(): getBaseIcon() for this submap doesn't return one of these
# files' pixels whole the way "glotek"/"neonite" above do — each 32-wide "frame" of the
# accompanying .mcmeta's animation is itself a 2x2 grid of four unrelated 16x16 icons (a fake
# computer screen effect: Java picks one per placement, changing which quadrant shows). Treating
# the whole 32x32 frame as this block's static appearance — what the generic top/side/single
# resolution above would do — is the actual bug reported: every face shows all 4 icons squashed
# together instead of one. There's no data-model equivalent for "a different icon per placed
# cell" here (principle 1: a block TYPE has one texture, never one that varies by position), so
# _chisel_icon_crop_faces below crops a fixed, representative icon instead — see
# MCHealContext.cropped_texture. group -> {meta -> texture base to crop}.
const _CHISEL_FAKE_CONTROLLER_CROP := {
	"futura": {
		2: "futura/WIP/controller",
		4: "futura/WIP/controllerPurple",
		5: "futura/WIP/uberWavy",
	},
}

# All six faces bound to the top-left 16x16 icon cropped out of `base`'s first frame — see
# _CHISEL_FAKE_CONTROLLER_CROP.
func _chisel_icon_crop_faces(ctx: MCHealContext, base: String) -> Dictionary:
	var ref := "%s/%s" % [_CHISEL_TEX, base]
	if not ctx.source_has_texture(ref):
		return {}
	var out_id := "chisel:heal/icon_%s" % base.replace("/", "_")
	var tex := ctx.cropped_texture(out_id, ref, Rect2i(0, 0, 16, 16))
	if tex == null:
		return {}
	return {
		BlockModel.Dir.UP: tex.id, BlockModel.Dir.DOWN: tex.id,
		BlockModel.Dir.NORTH: tex.id, BlockModel.Dir.SOUTH: tex.id,
		BlockModel.Dir.EAST: tex.id, BlockModel.Dir.WEST: tex.id,
	}

func _chisel_candidates(group: String, base: String) -> Array[String]:
	return [base, "%s/%s" % [group.to_lower(), base]]

func _chisel_single(ctx: MCHealContext, group: String, base: String) -> String:
	for candidate in _chisel_candidates(group, base):
		var ref := "%s/%s" % [_CHISEL_TEX, candidate]
		if ctx.source_has_texture(ref):
			var tex := ctx.ensure_texture(ref)
			if tex != null:
				return tex.id
	return ""

func _chisel_pair(ctx: MCHealContext, group: String, base: String) -> Dictionary:
	var tex := _chisel_top_side(ctx, group, base)
	if tex.is_empty():
		return {}
	return {
		BlockModel.Dir.UP: tex["top"], BlockModel.Dir.DOWN: tex["top"],
		BlockModel.Dir.NORTH: tex["side"], BlockModel.Dir.SOUTH: tex["side"],
		BlockModel.Dir.EAST: tex["side"], BlockModel.Dir.WEST: tex["side"],
	}

# The resolved {"top":id, "side":id} texture pair for a column/pillar/pane-shaped
# group, or {} if no candidate/suffix combination resolves both files (see class doc
# for the fallback chain). Shared by _chisel_pair (a cube's UP/DOWN vs N/E/S/W faces)
# and _heal_chisel_pane (a real pane's edge-rim vs flat-face textures) — same two
# files, different geometry built from them.
func _chisel_top_side(ctx: MCHealContext, group: String, base: String) -> Dictionary:
	for candidate in _chisel_candidates(group, base):
		var top_ref := "%s/%s-top" % [_CHISEL_TEX, candidate]
		if not ctx.source_has_texture(top_ref):
			continue
		for suffix in _CHISEL_SIDE_SUFFIXES:
			var side_ref := "%s/%s%s" % [_CHISEL_TEX, candidate, suffix]
			if not ctx.source_has_texture(side_ref):
				continue
			var top := ctx.ensure_texture(top_ref)
			var side := ctx.ensure_texture(side_ref)
			if top != null and side != null:
				return {"top": top.id, "side": side.id}
	return {}

# { "chisel.<group>" -> "<group display>", "<group>.<meta>" -> "<variant display>" } parsed
# straight from Chisel's own shipped en_US.lang (inside its own source, not a sibling file —
# read_sibling_text is for mod data that lives NEXT to the jar, this lives inside it), keyed to
# match how _heal_chisel looks them up. "" (missing file) yields an empty map; every lookup above
# already has a prettified-group-name fallback.
func _parse_chisel_lang(ctx: MCHealContext) -> Dictionary:
	var out := {}
	var raw_kv := {}
	var text := ctx.source.read_text("chisel/lang/en_US.lang")
	for raw in text.split("\n"):
		var line := raw.strip_edges()
		var eq := line.find("=")
		if eq < 0:
			continue
		var key := line.substr(0, eq).strip_edges()
		var val := line.substr(eq + 1).strip_edges()
		raw_kv[key] = val
		if key.begins_with("tile.chisel.") and key.ends_with(".name"):
			out["chisel.%s" % key.trim_prefix("tile.chisel.").trim_suffix(".name")] = val
		elif key.begins_with("tile.") and key.ends_with(".desc"):
			out[key.trim_prefix("tile.").trim_suffix(".desc")] = val
	_add_stained_glass_names(out, raw_kv)
	return out

# Chisel's two dyed-glass families ("stained_glass_<color>" and "stained_glass_pane_<color>" —
# see ChiselVariations' own table entries for the full derivation) name their variants as
# "<featureColor>.<style>.desc" and "<featureColor>.pane.<style>.desc" respectively — not the
# "tile.<group>.<meta>.desc" shape the loop above parses — so inject the same names under the
# "SGP_DISPLAY:<group>:<meta>" keys _heal_chisel checks first, ahead of its meta-0 shortcut
# (unlike every other group, meta 0 here IS a real named variant, not flavor text).
# color -> meta base, one table per family (the two pack a different number of colors onto each
# shared block: 4 colors/block for the plain family, 2 for the pane family — see the table's own
# comment for the (i & 3) << 2 vs (i & 1) << 3 derivation).
const _STAINED_GLASS_META_BASE := {
	"white": 0, "orange": 4, "magenta": 8, "lightblue": 12,
	"yellow": 0, "lime": 4, "pink": 8, "gray": 12,
	"lightgray": 0, "cyan": 4, "purple": 8, "blue": 12,
	"brown": 0, "green": 4, "red": 8, "black": 12,
}
const _STAINED_GLASS_PANE_META_BASE := {
	"white": 0, "orange": 8, "magenta": 0, "lightblue": 8,
	"yellow": 0, "lime": 8, "pink": 0, "gray": 8,
	"lightgray": 0, "cyan": 8, "purple": 0, "blue": 8,
	"brown": 0, "green": 8, "red": 0, "black": 8,
}
# featureColors[] disagrees with the color name above only for this one entry (see
# ChiselVariations' comment) — every other color's lang-key prefix matches its group name.
const _STAINED_GLASS_LANG_COLOR := {"gray": "darkgray"}
# (meta offset from the color's base above, lang key's style fragment) — the plain family only
# has the first 4 (no quadrant styles; see ChiselVariations' comment).
const _STAINED_GLASS_STYLES := [
	[0, "bubble"], [1, "glass"], [2, "glass.fancy"], [3, "glass.noborder"],
]
const _STAINED_GLASS_PANE_STYLES := _STAINED_GLASS_STYLES + [
	[4, "glass.quadrant"], [5, "glass.fancyquadrant"],
]

func _add_stained_glass_names(out: Dictionary, raw_kv: Dictionary) -> void:
	for color in _STAINED_GLASS_META_BASE:
		_add_dyed_glass_names(out, raw_kv, "stained_glass_%s" % color,
			_STAINED_GLASS_META_BASE[color], color, "")
	for color in _STAINED_GLASS_PANE_META_BASE:
		_add_dyed_glass_names(out, raw_kv, "stained_glass_pane_%s" % color,
			_STAINED_GLASS_PANE_META_BASE[color], color, "pane.")

func _add_dyed_glass_names(out: Dictionary, raw_kv: Dictionary, group: String, base: int,
		color: String, infix: String) -> void:
	var lang_color: String = _STAINED_GLASS_LANG_COLOR.get(color, color)
	var styles := _STAINED_GLASS_PANE_STYLES if not infix.is_empty() else _STAINED_GLASS_STYLES
	for style in styles:
		var lang_key := "%s.%s%s.desc" % [lang_color, infix, style[1]]
		if raw_kv.has(lang_key):
			out["SGP_DISPLAY:%s:%d" % [group, base + int(style[0])]] = raw_kv[lang_key]

# ===========================================================================
# ProjectRed Illumination — the "Lamp" block (registry projectred.illumination.lamp): 32
# metas, 16 vanilla-dye colors x off/on (0-15 = normal, lit only while powered; 16-31 =
# "Inverted", lit only while UNpowered — a real, GTNH-microblocks.cfg-absent light source with
# a flat, textureless color, unlike every ztones/concrete option). No blockstate/model JSON
# ships in this mod at all (confirmed: 1.7.10 pure-Java icon registration), so the generic
# importer can never find these on its own — each color+state is its own numbered file
# (textures/blocks/lighting/lampoff/<0-15>.png, lampon/<0-15>.png). Shown at its natural idle
# look: off for normal, on for inverted, matching how each would actually sit unpowered.
# ProjectRed's other Illumination blocks (lanterns, fixtures, cage lamps, buttons) use flat
# single-file textures with no per-color art at all (colors are a name/item distinction only,
# not a texture one) — not modeled here; a real motive to add one shows they're wanted too.
# ===========================================================================

const _PROJRED_LAMP_REGISTRY := "ProjRed|Illumination:projectred.illumination.lamp"

func _heal_projred_illumination(ctx: MCHealContext) -> void:
	for meta in 32:
		var inverted := meta >= 16
		var color_idx := meta - 16 if inverted else meta
		var state := "lampon" if inverted else "lampoff"
		var ref := "projectred:blocks/lighting/%s/%d" % [state, color_idx]
		if not ctx.source_has_texture(ref):
			continue
		var tex := ctx.ensure_texture(ref)
		if tex == null:
			continue
		var display := "%s%s Lamp" % ["Inverted " if inverted else "", _DYE_COLORS[color_idx].capitalize()]
		var faces := {
			BlockModel.Dir.UP: tex.id, BlockModel.Dir.DOWN: tex.id,
			BlockModel.Dir.NORTH: tex.id, BlockModel.Dir.SOUTH: tex.id,
			BlockModel.Dir.EAST: tex.id, BlockModel.Dir.WEST: tex.id,
		}
		var bt := ctx.add_cube(_stable_name(ctx, _PROJRED_LAMP_REGISTRY, meta, display), faces,
			tex.average_color, PackedStringArray(["light", "lamp", "projred"]), "ProjRed|Illumination")
		ctx.confirm_registry(bt, _PROJRED_LAMP_REGISTRY, meta, "ProjRed|Illumination", display)

# ===========================================================================
# Extra Utilities — "Lapis Caelestis" (registry ExtraUtilities:greenscreen, meta 0-15): a
# flat, borderless solid-color block, real in-game light source (its own BlockGreenScreen
# overrides getLightValue as the average of its own RGB × 15 — a bright color like white/
# cyan glows near max, a dark one like black or brown barely glows at all, confirmed from
# source, see below). One shared, effectively blank texture in the jar (a tiny near-white
# 16x16 PNG, greenscreen.png) recolored per meta purely in Java (BlockGreenScreen's own
# `cols` array) — no blockstate/model, so nothing generic could ever find 16 variants from
# one file. Synthesized here as 16 solid-color textures instead of reading the source art at
# all (see MCHealContext.solid_texture) — reading it first and tinting it would produce the
# same result, since it's blank, but this is simpler and doesn't depend on that staying true.
# Colors + Latin/English names confirmed against the mod's real source (`cols` array,
# https://github.com/sameer/ExtraUtilities/blob/master/ExtraUtilitiesBuilder/src/main/java/com/rwtema/extrautils/block/BlockGreenScreen.java)
# cross-checked against the modpack's own NEI itempanel.csv display names.
# ===========================================================================

const _EXTRAUTILS_LAPIS_REGISTRY := "ExtraUtilities:greenscreen"
# meta -> [display name, hex RGB] — both confirmed against real source, see class doc above.
const _EXTRAUTILS_LAPIS_COLORS := [
	["Lapis Caelestis Albus (White)", 0xFFFFFF],
	["Lapis Caelestis Aurantiacus (Orange)", 0xFF8000],
	["Lapis Caelestis Purpura Amethystinus (Magenta)", 0xFF00FF],
	["Lapis Caelestis Caesicius (Light Blue)", 0x007EDD],
	["Lapis Caelestis Flavus (Yellow)", 0xFFFF00],
	["Lapis Caelestis Viridis (Green)", 0x00FF00],
	["Lapis Caelestis Roseus (Pink)", 0xFF99A6],
	["Lapis Caelestis Cinereus (Gray)", 0x7F7F7F],
	["Lapis Caelestis Lux Cinereus (Light Gray)", 0xD3D3D3],
	["Lapis Caelestis Callainus (Cyan)", 0x00FFFF],
	["Lapis Caelestis Purpura (Purple)", 0xAB33FF],
	["Lapis Caelestis Caeruleus (Blue)", 0x0000FF],
	["Lapis Caelestis Fuscus (Brown)", 0x2A3300],
	["Lapis Caelestis Paphiae Myrti (Dark Green)", 0x009900],
	["Lapis Caelestis Rufus (Red)", 0xFF0000],
	["Lapis Caelestis Nox (Black)", 0x000000],
]

func _heal_extrautilities(ctx: MCHealContext) -> void:
	for meta in _EXTRAUTILS_LAPIS_COLORS.size():
		var display: String = _EXTRAUTILS_LAPIS_COLORS[meta][0]
		var color := Color.hex((int(_EXTRAUTILS_LAPIS_COLORS[meta][1]) << 8) | 0xFF)
		var tex := ctx.solid_texture("extrautils:heal/greenscreen_%d" % meta, color)
		var faces := {
			BlockModel.Dir.UP: tex.id, BlockModel.Dir.DOWN: tex.id,
			BlockModel.Dir.NORTH: tex.id, BlockModel.Dir.SOUTH: tex.id,
			BlockModel.Dir.EAST: tex.id, BlockModel.Dir.WEST: tex.id,
		}
		var bt := ctx.add_cube(_stable_name(ctx, _EXTRAUTILS_LAPIS_REGISTRY, meta, display), faces, color,
			PackedStringArray(["light", "lapis caelestis", "extrautils"]), "ExtraUtilities")
		ctx.confirm_registry(bt, _EXTRAUTILS_LAPIS_REGISTRY, meta, "ExtraUtilities", display)

# ===========================================================================
# Ztones — gives the "Flat Lamp" trio (registries lampf/lampt/lampb) a default LOOK closer
# to what they actually are. Decompiling BlockLampFlat/Transparent/Black shows none of the
# three are real full blocks: getCollisionBoundingBox is null, isOpaqueCube/
# renderAsNormalBlock are both false, and setBlockBounds picks one of six 0.1-thick plates
# flush against whichever face the block is placed on (a wall/ceiling/floor-mounted
# fixture) — the presumptive import has no way to know that and falls back to a full cube,
# which is what the library browser (outside any palette) was showing. This only replaces
# the block's own DEFAULT model with the ceiling-mounted case (the most immediately
# recognizable of the six as "a light fixture" rather than "a block"): never a substitute
# for the palette's own Cover shape, which is still how a real placement picks its actual
# face (up/down/sideways) and generates its own geometry regardless of this default.
#
# Deliberately NOT renamed: the three share Ztones' own single "Flat Lamp" name with no
# distinguishing text at all, but that's a per-project palette/semantic naming choice, not
# something to bake into the shared library block.
# ===========================================================================

const _ZTONES_LAMPS := ["lampf", "lampt", "lampb"]
# The ceiling-mounted case from BlockLampFlat's own decompiled setBlockBounds: a 0.1-thick
# plate flush against the top face.
const _ZTONES_LAMP_FROM := Vector3(0, 0.9, 0)
const _ZTONES_LAMP_TO := Vector3(1, 1, 1)

func _heal_ztones(ctx: MCHealContext) -> void:
	for reg_name in _ZTONES_LAMPS:
		var bt := ctx.existing_for("Ztones:%s" % reg_name, 0)
		if bt == null:
			continue
		var old_model := ctx.library.get_block_model(bt.model_id)
		if old_model == null or old_model.textures.is_empty():
			continue
		var tex_id: String = old_model.textures.keys()[0]
		var faces := {
			BlockModel.Dir.UP: tex_id, BlockModel.Dir.DOWN: tex_id,
			BlockModel.Dir.NORTH: tex_id, BlockModel.Dir.SOUTH: tex_id,
			BlockModel.Dir.EAST: tex_id, BlockModel.Dir.WEST: tex_id,
		}
		ctx.add_cube(bt.name, faces, bt.color, bt.tags, "", _ZTONES_LAMP_FROM, _ZTONES_LAMP_TO)

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

# The name to give a confirmed cube: the SAME block a previous run already confirmed for this
# exact registry+meta, if there is one, so add_cube() updates it in place (texture/model/tags
# refreshed, name and any palette references untouched) instead of unique_name() minting a
# "Name 2", "Name 3", … duplicate every time the import runs again. Every heal function below
# that confirms a real MC identity should name its cube through this, not unique_name() directly.
func _stable_name(ctx: MCHealContext, registry: String, meta: int, display: String) -> String:
	var existing := ctx.existing_for(registry, meta)
	return existing.name if existing != null else ctx.unique_name(display)

func _avg(ctx: MCHealContext, tex_id: String) -> Color:
	if tex_id.is_empty():
		return Color(0.5, 0.5, 0.5)
	var a := ctx.library.get_texture_asset(tex_id)
	return a.average_color if a != null else Color(0.5, 0.5, 0.5)

func _norm(s: String) -> String:
	return s.replace("_", "").to_lower()

func _prettify(folder: String) -> String:
	return folder.replace("_", " ").capitalize()
