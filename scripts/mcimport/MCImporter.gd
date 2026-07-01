class_name MCImporter
extends RefCounted

# THE Minecraft → voxyl translator (Phase 2). This is the one place that knows MC's
# resource layout — `assets/<namespace>/{blockstates,models,textures}` — and turns
# it into voxyl's neutral material layer (BlockModel / TextureAsset / BlockStateMap /
# BlockType). It is a *plugin on top* of the core types (architectural guardrail):
# the core stays MC-free; every MC-ism (namespaces, `minecraft:` ids, ticks, the
# 0–16 coordinate space, blockstate property strings) is converted here and never
# leaks past this module. It is a reader, never a content source (decision 4) — it
# copies from assets the user already owns and bundles nothing.
#
# Modded MC is nearly free: mods ship the identical `assets/<namespace>/...` layout
# inside their jars (unzipped). `import_all()` walks every namespace under the root;
# each imports the same way.
#
# Usage:
#   var imp := MCImporter.new(source, VoxelWorld.workspace)
#   imp.import_namespace("minecraft")      # or imp.import_all()
#   # → workspace libraries are filled in memory + pixels copied to disk;
#   # the caller persists with LibraryStore.save_all(workspace).
#
# `source` is an MCAssetSource — the assets root that directly contains the
# namespace folders, whether that's a directory on disk or inside a resource-pack
# `.zip` / mod `.jar`. For convenience (and the existing tests) a plain String path
# is accepted and wrapped in an MCDirSource. Reads go through the source; writes
# (copied pixels) go through AssetLibrary so the storage root stays the one swap
# point (decision 3).

# MC face / direction names, in BlockModel.Dir order (NORTH,EAST,SOUTH,WEST,UP,DOWN).
# Orientation.Facing shares the same ordering, so this one table serves both the
# model face directions and blockstate `facing=` values.
const _DIR6 := {
	"north": 0, "east": 1, "south": 2, "west": 3, "up": 4, "down": 5,
}

var _source: MCAssetSource
var _library: BlockLibrary

# Per-run caches. Resolved model JSON is cached by ref so the shared MC templates
# (block/block, block/cube, block/cube_all, …) are parsed once even though hundreds
# of blocks inherit them. Model/texture dedup into the workspace itself.
var _resolved_cache := {}   # model ref -> { textures, elements, ao }

# Diagnostics the caller (and tests) can inspect after a run.
var imported_blocks: Array[String] = []
var warnings: Array[String] = []

func _init(source, library: BlockLibrary) -> void:
	_source = source if source is MCAssetSource else MCDirSource.new(source)
	_library = library

# ---------------------------------------------------------------------------
# Browse (Phase 5) — list what's importable without importing anything.
# ---------------------------------------------------------------------------

# Namespaces the source offers (its top-level dirs), for the import browser.
func list_namespaces() -> PackedStringArray:
	return _source.list_namespaces()

# Block ids (blockstate basenames) under a namespace — the browsable, importable
# blocks, with nothing imported yet.
func list_blocks(ns: String) -> PackedStringArray:
	var out := PackedStringArray()
	for file_name in _source.list_files("%s/blockstates" % ns):
		if file_name.ends_with(".json"):
			out.append(file_name.get_basename())
	return out

# ---------------------------------------------------------------------------
# Entry points
# ---------------------------------------------------------------------------

# Import every namespace found directly under the assets root (the modded case).
func import_all() -> void:
	for ns in _source.list_namespaces():
		import_namespace(ns)

# Import every block whose blockstate lives under `<ns>/blockstates/`.
func import_namespace(ns: String) -> void:
	var files := _source.list_files("%s/blockstates" % ns)
	if files.is_empty():
		_warn("no blockstates for namespace: %s" % ns)
		return
	for file_name in files:
		if file_name.ends_with(".json"):
			import_block(ns, file_name.get_basename())

# Translate one block (its blockstate + every model/texture it references) into a
# BlockType in the workspace. Returns the BlockType, or null if it couldn't be read
# or used a form not handled yet. Idempotent by name. `name_override` lets a caller
# (the import service deduping across namespaces) name the BlockType something other
# than the bare block id — e.g. the qualified "ns:id" — without the importer needing
# to know about collisions; "" keeps the bare block id.
func import_block(ns: String, block_id: String, name_override := "") -> BlockType:
	var bt_name := name_override if not name_override.is_empty() else block_id
	var bs = _read_json(_blockstate_rel(ns, block_id))
	if bs == null:
		_warn("unreadable blockstate: %s:%s" % [ns, block_id])
		return null
	if bs.has("multipart"):
		return _import_multipart(ns, block_id, bt_name, bs["multipart"])
	if not bs.has("variants"):
		_warn("blockstate has no variants: %s:%s" % [ns, block_id])
		return null

	var variants := _parse_variants(bs["variants"])
	if variants.is_empty():
		_warn("no usable variants: %s:%s" % [ns, block_id])
		return null

	# Import each referenced model and build the orientation → model map.
	var state_map := BlockStateMap.new()
	for v in variants:
		if _ensure_model(v["model_ref"]) == null:
			continue
		state_map.add_variant(v["facing"], v["top"], v["model_ref"], v["x"], v["y"], v["uvlock"])
	if state_map.is_empty():
		_warn("all variant models failed to import: %s:%s" % [ns, block_id])
		return null

	# The resting-orientation model is what BlockType.model_id and the current 3D
	# path resolve; sample its dominant texture for the planning color (decision 1).
	return _emit_block_type(bt_name, state_map.default_model_id(), state_map)

# Translate an MC `multipart` blockstate (fences, panes, bars) into a multipart
# BlockStateMap. Each rule is { when?, apply }: `apply` names the model (+ optional
# x/y rotation), `when` the connection condition. Boolean direction conditions
# (north/east/…=true/false) are translated; multi-value vocabularies (walls'
# low/tall, redstone's side/up) are out of this phase — those parts are skipped
# (warned), so the block still imports with whatever parts we can render (at least
# the always-on post).
func _import_multipart(ns: String, block_id: String, bt_name: String, multipart) -> BlockType:
	if not (multipart is Array):
		_warn("malformed multipart: %s:%s" % [ns, block_id])
		return null
	var state_map := BlockStateMap.new()
	for rule in multipart:
		if not (rule is Dictionary):
			continue
		var apply = rule.get("apply")
		if apply is Array:
			apply = apply[0] if not apply.is_empty() else null   # weighted → first
		if not (apply is Dictionary):
			continue
		var model_ref := _canonical(str(apply.get("model", "")))
		if _ensure_model(model_ref) == null:
			continue
		var clauses = _parse_when(rule.get("when", null))
		if clauses == null:
			_warn("multipart part skipped (unhandled 'when'): %s:%s" % [ns, block_id])
			continue
		state_map.add_part(clauses, model_ref,
			int(apply.get("x", 0)), int(apply.get("y", 0)), bool(apply.get("uvlock", false)))
	if state_map.parts.is_empty():
		_warn("multipart had no usable parts: %s:%s" % [ns, block_id])
		return null
	return _emit_block_type(bt_name, state_map.default_part_model_id(), state_map)

# Translate an MC `when` condition into the neutral OR-of-clauses form. Returns the
# clause Array ([] when the rule has no `when` → always applies), or null when the
# condition can't be expressed with boolean direction flags (caller skips the part).
func _parse_when(when):
	if when == null:
		return []                          # no condition → always
	if not (when is Dictionary):
		return null
	if when.has("OR"):
		var clauses: Array = []
		for sub in when["OR"]:
			var c = _parse_clause(sub)
			if c != null:                  # drop sub-clauses we can't translate
				clauses.append(c)
		if clauses.is_empty():
			return null
		return clauses
	if when.has("AND"):
		return null                        # nested AND-of-conditions not handled yet
	var clause = _parse_clause(when)
	if clause == null:
		return null
	return [clause]

# One MC `when` clause (a dict of property=value) → { dir:int -> bool }, or null if
# any property isn't a boolean direction connection (e.g. shape=, or walls' low/tall).
func _parse_clause(d):
	if not (d is Dictionary):
		return null
	var clause := {}
	for k in d.keys():
		var dir: int = _DIR6.get(str(k), -1)
		if dir < 0:
			return null
		var v := str(d[k]).to_lower()
		if v != "true" and v != "false":
			return null
		clause[dir] = (v == "true")
	return clause

# Create/update the BlockType for an imported block: bind its primary model, nest
# the state map, and mirror the dominant texture's average into the planning color.
# `bt_name` is the final, possibly-deduped name (bare block id or qualified "ns:id").
func _emit_block_type(bt_name: String, primary_ref: String, state_map: BlockStateMap) -> BlockType:
	var primary_model := _library.get_block_model(primary_ref)
	var bt := _library.get_block_type(bt_name)
	if bt == null:
		bt = _library.add_block_type(bt_name)
	bt.model_id = primary_ref
	bt.state_map = state_map
	var avg = _model_average_color(primary_model)
	if avg != null:
		bt.color = avg
	_apply_tint(bt, primary_model)
	if not imported_blocks.has(bt_name):
		imported_blocks.append(bt_name)
	return bt

# ---------------------------------------------------------------------------
# Blockstate variants
# ---------------------------------------------------------------------------

# Flatten a `variants` dict into a list of {facing, top, model_ref, x, y, uvlock}.
# Properties voxyl doesn't model (shape=, waterlogged=, …) are dropped — the plan's
# "flatten unmodeled properties to a sensible default". A weighted-random variant
# (an array of models) takes the first.
#
# `shape` (stairs) is special: its inner_/outer_ values are *contextual corner forms*
# that depend on neighbors — the same thing voxyl declines to model for multipart
# connections. Flattening them onto the same (facing, half) as the straight form let a
# corner model win as the block's primary, so a stair read as already-connected on two
# sides. When a block offers a `shape=straight` resting form we keep only that; blocks
# whose shape vocabulary has no straight (rails) are untouched.
func _parse_variants(variants) -> Array:
	var out: Array = []
	if not (variants is Dictionary):
		return out
	var has_straight := false
	for state_str in variants.keys():
		if _variant_shape(state_str) == "straight":
			has_straight = true
			break
	for state_str in variants.keys():
		if has_straight:
			var shape := _variant_shape(state_str)
			if shape != "" and shape != "straight":
				continue
		var val = variants[state_str]
		if val is Array:
			val = val[0] if not val.is_empty() else null
		if not (val is Dictionary):
			continue
		var so := _state_to_orientation(state_str)
		out.append({
			"facing": so["facing"],
			"top": so["top"],
			"model_ref": _canonical(str(val.get("model", ""))),
			"x": int(val.get("x", 0)),
			"y": int(val.get("y", 0)),
			"uvlock": bool(val.get("uvlock", false)),
		})
	return out

# The value of the `shape` property in an MC state string ("…,shape=inner_left" →
# "inner_left"), or "" when absent. Used to keep only a stair's resting straight form.
func _variant_shape(state_str: String) -> String:
	for prop in state_str.split(","):
		var kv := prop.split("=")
		if kv.size() == 2 and kv[0] == "shape":
			return kv[1]
	return ""

# Parse an MC state string ("facing=east,half=top") into voxyl orientation parts.
# Only facing + the top/bottom half are meaningful to voxyl; everything else is
# ignored. "" (the state-less variant) → the ANY_FACING default.
func _state_to_orientation(state_str: String) -> Dictionary:
	var facing := BlockStateMap.ANY_FACING
	var top := false
	if state_str != "":
		for prop in state_str.split(","):
			var kv := prop.split("=")
			if kv.size() != 2:
				continue
			match kv[0]:
				"facing":
					facing = _DIR6.get(kv[1], BlockStateMap.ANY_FACING)
				"half":
					top = kv[1] == "top"     # stairs/doors/trapdoors
				"type":
					top = kv[1] == "top"     # slabs (type=top/bottom/double)
	return {"facing": facing, "top": top}

# ---------------------------------------------------------------------------
# Models (parent chain → neutral BlockModel)
# ---------------------------------------------------------------------------

# Ensure a BlockModel exists in the workspace for `model_ref` (importing it, with
# its full parent chain merged and textures copied, on first sight). Deduped by id —
# the same MC model file referenced by many blocks is imported once. The id is the
# qualified ref ("minecraft:block/stone"), which uniquely names the resolved
# geometry+textures, so models are shared exactly when those match (Phase 1 note).
func _ensure_model(model_ref: String) -> BlockModel:
	if model_ref.is_empty():
		return null
	var existing := _library.get_block_model(model_ref)
	if existing != null:
		return existing
	var resolved = _resolve_model_json(model_ref, 0)
	if resolved == null:
		_warn("model not found: %s" % model_ref)
		return null
	var conv := _convert_elements(resolved["elements"], resolved["textures"])
	if conv["elements"].is_empty():
		# A bodiless model (e.g. a pure parent like block/block) can't render on its
		# own; skip it rather than create an empty BlockModel.
		_warn("model has no usable geometry: %s" % model_ref)
		return null
	var model := BlockModel.new()
	model.id = model_ref
	model.elements = conv["elements"]
	model.textures = conv["textures"]
	model.ambient_occlusion = resolved["ao"]
	_library.add_block_model(model)
	return model

# A model's `textures` entry is normally a bare "ns:path" (or "#var") string, but
# newer MC versions allow an object form ({ "sprite": "ns:path", "force_translucent":
# true, … }) to attach render hints alongside the ref. voxyl has no use for those
# hints (transparency is auto-detected from the PNG's own alpha), so unwrap to the
# sprite ref and drop the rest.
func _texture_ref_str(v) -> String:
	if v is Dictionary:
		return str(v.get("sprite", ""))
	return str(v)

# Resolve a model file and its parent chain into merged { textures, elements, ao }.
# MC merge rules: textures accumulate child-wins; elements are inherited wholesale
# unless the child defines its own (then they replace). Missing parents (builtin/*,
# absent files) stop the chain gracefully. Cached by ref.
func _resolve_model_json(model_ref: String, depth: int):
	if depth > 20:
		_warn("model parent chain too deep at %s" % model_ref)
		return null
	if _resolved_cache.has(model_ref):
		return _resolved_cache[model_ref]
	var j = _read_json(_model_rel(model_ref))
	if j == null:
		return null
	var base := {"textures": {}, "elements": [], "ao": true}
	if j.has("parent"):
		var p = _resolve_model_json(_canonical(str(j["parent"])), depth + 1)
		if p != null:
			base["textures"] = (p["textures"] as Dictionary).duplicate()
			base["elements"] = p["elements"]
			base["ao"] = p["ao"]
	if j.has("textures"):
		for k in j["textures"]:
			base["textures"][k] = _texture_ref_str(j["textures"][k])
	if j.has("elements"):
		base["elements"] = j["elements"]
	if j.has("ambientocclusion"):
		base["ao"] = bool(j["ambientocclusion"])
	_resolved_cache[model_ref] = base
	return base

# Convert merged MC elements → BlockModel elements, importing each referenced
# texture. Returns { elements, textures }. `textures` maps a texture_key to a
# TextureAsset id; here the key *is* the texture id (the qualified ref), so faces
# sharing a texture share one render surface (max sharing). Faces whose texture can't
# be resolved/loaded are dropped; an element with no surviving face is dropped.
func _convert_elements(mc_elements, textures_map: Dictionary) -> Dictionary:
	var out_elements: Array = []
	var used: Dictionary = {}   # texture id -> true
	for me in mc_elements:
		var from16 = me.get("from", [0, 0, 0])
		var to16 = me.get("to", [16, 16, 16])
		var from := Vector3(from16[0], from16[1], from16[2]) / 16.0
		var to := Vector3(to16[0], to16[1], to16[2]) / 16.0
		var faces := {}
		var mc_faces = me.get("faces", {})
		for fname in mc_faces:
			var dir: int = _DIR6.get(fname, -1)
			if dir < 0:
				continue
			var mface = mc_faces[fname]
			var tex_path := _resolve_texture_var(textures_map, str(mface.get("texture", "")), 0)
			if tex_path.is_empty():
				_warn("unresolved face texture '%s' on %s face" % [str(mface.get("texture", "")), fname])
				continue
			var asset := _ensure_texture(tex_path)
			if asset == null:
				continue
			used[asset.id] = true
			faces[dir] = {
				"texture_key": asset.id,
				"uv": _face_uv(mface, dir, from16, to16),
				"cullface": _DIR6.get(str(mface.get("cullface", "")), -1),
				"rotation": int(mface.get("rotation", 0)),
				"tint_index": int(mface.get("tintindex", -1)),
			}
		if not faces.is_empty():
			var el := {"from": from, "to": to, "faces": faces}
			var rotation := _convert_rotation(me.get("rotation", null))
			if not rotation.is_empty():
				el["rotation"] = rotation
			out_elements.append(el)
	var textures := {}
	for tid in used:
		textures[tid] = tid
	return {"elements": out_elements, "textures": textures}

# Convert an MC element `rotation` ({ origin:[0–16]×3, axis:"x"|"y"|"z", angle:deg,
# rescale:bool }) into BlockMesher's neutral form (origin in 0–1, axis as a unit vector,
# angle in radians). MC only ever rotates about one cardinal axis at ±22.5/±45°. Returns
# {} when the element has no usable rotation, so axis-aligned elements stay plain.
func _convert_rotation(rot) -> Dictionary:
	if not (rot is Dictionary) or not rot.has("axis"):
		return {}
	var axis: Vector3
	match str(rot["axis"]):
		"x": axis = Vector3(1, 0, 0)
		"y": axis = Vector3(0, 1, 0)
		"z": axis = Vector3(0, 0, 1)
		_: return {}
	var o = rot.get("origin", [8, 8, 8])
	return {
		"origin": Vector3(o[0], o[1], o[2]) / 16.0,
		"axis": axis,
		"angle": deg_to_rad(float(rot.get("angle", 0))),
		"rescale": bool(rot.get("rescale", false)),
	}

# Follow a face's "#var" through the textures map to a concrete texture ref. A value
# that doesn't start with "#" is already a ref (possibly bare, qualified later).
func _resolve_texture_var(textures_map: Dictionary, value: String, depth: int) -> String:
	if depth > 20 or value.is_empty():
		return ""
	if value.begins_with("#"):
		var key := value.substr(1)
		if not textures_map.has(key):
			return ""
		return _resolve_texture_var(textures_map, str(textures_map[key]), depth + 1)
	return value

# ---------------------------------------------------------------------------
# Textures (PNG + .mcmeta → TextureAsset)
# ---------------------------------------------------------------------------

# Ensure a TextureAsset exists for a texture ref — delegated to the shared ingestion
# helper so both MC importers copy/scan/animate pixels identically.
func _ensure_texture(texture_ref: String) -> TextureAsset:
	return MCTexImport.ensure_texture(_library, _source, texture_ref, warnings)

# ---------------------------------------------------------------------------
# UVs + sampling helpers
# ---------------------------------------------------------------------------

# A face's UV rect in [0,1], V measured from the texture top (matches View3D._add_face
# and how the animation shader walks the strip). Explicit MC uv is [x1,y1,x2,y2] in
# 0–16; when omitted MC derives it from the element's footprint (exact for full faces,
# a faithful sub-rect for partial ones — e.g. a bottom slab samples the lower half).
func _face_uv(mface, dir: int, from16, to16) -> Rect2:
	if mface.has("uv"):
		var u = mface["uv"]
		var x1: float = minf(u[0], u[2]); var x2: float = maxf(u[0], u[2])
		var y1: float = minf(u[1], u[3]); var y2: float = maxf(u[1], u[3])
		return Rect2(x1 / 16.0, y1 / 16.0, (x2 - x1) / 16.0, (y2 - y1) / 16.0)
	var x1f := float(from16[0]); var y1f := float(from16[1]); var z1f := float(from16[2])
	var x2f := float(to16[0]); var y2f := float(to16[1]); var z2f := float(to16[2])
	match dir:
		4, 5:   # UP / DOWN — spans X,Z (top-down)
			return Rect2(x1f / 16.0, z1f / 16.0, (x2f - x1f) / 16.0, (z2f - z1f) / 16.0)
		1, 3:   # EAST / WEST — spans Z, and Y from the top
			return Rect2(z1f / 16.0, (16.0 - y2f) / 16.0, (z2f - z1f) / 16.0, (y2f - y1f) / 16.0)
		_:      # NORTH / SOUTH — spans X, and Y from the top
			return Rect2(x1f / 16.0, (16.0 - y2f) / 16.0, (x2f - x1f) / 16.0, (y2f - y1f) / 16.0)

# Average color of the model's dominant texture (the one bound to the most faces),
# already sampled at texture import. null when the model carries no loadable texture.
func _model_average_color(model: BlockModel):
	if model == null or model.textures.is_empty():
		return null
	var asset := _library.get_texture_asset(_dominant_texture_key(model))
	if asset != null:
		return asset.average_color
	return null

# The texture_key bound to the most faces — the block's "main" texture, used both
# for the planning color and for deciding whether to fold a tint into it. Falls
# back to the first declared binding when the face scan is inconclusive.
func _dominant_texture_key(model: BlockModel) -> String:
	var counts := {}
	for element in model.elements:
		for dir in element["faces"]:
			var key: String = element["faces"][dir]["texture_key"]
			counts[key] = int(counts.get(key, 0)) + 1
	var best_key := ""
	var best := -1
	for key in counts:
		if counts[key] > best:
			best = counts[key]; best_key = key
	if best_key.is_empty() and not model.textures.is_empty():
		best_key = model.textures.keys()[0]
	return model.textures.get(best_key, best_key)

# ---------------------------------------------------------------------------
# Tint (Phase 4) — bake MC's biome colors into the neutral material layer.
#
# MC tints grayscale "tintindex" textures (grass, leaves, water) from per-biome
# colormaps decided in Java code, NOT in the assets — the model JSON only carries a
# `tintindex` flag per face. voxyl has no biomes, so we resolve the tint to a single
# plains/default-biome color here (the one MC-specific bit, living in the importer
# plugin) and stash it on BlockType.tint; the 3D view multiplies it into the tinted
# faces. Which faces are tinted stays neutral data (the face's tint_index, already
# converted in _convert_elements).
# ---------------------------------------------------------------------------

# MC's plains/default-biome tint colors (the swatches the colormaps yield at the
# plains climate point). Users can re-tint per block afterwards — this is just the
# import-time default the plan calls for.
const _PLAINS_GRASS := Color(0.5686, 0.7412, 0.3490)    # #91BD59
const _PLAINS_FOLIAGE := Color(0.4667, 0.6706, 0.1843)  # #77AB2F
const _WATER_TINT := Color(0.2471, 0.4627, 0.8941)      # #3F76E4

# Set BlockType.tint from the model's tinted faces (those with tint_index >= 0). No
# tinted faces → leave it WHITE (no tint). Also marks each genuinely-tinted texture's
# tint_source (only textures actually used on a tintindex face, so grass_block_side —
# pre-composited, untinted — is never mis-marked). When the planning color itself
# comes from a tinted texture, the tint is folded into BlockType.color so the
# grey-source 2D/planning views still read as green/blue.
func _apply_tint(bt: BlockType, model: BlockModel) -> void:
	if model == null:
		return
	var tinted_counts := {}   # texture_key -> count of tinted faces using it
	for element in model.elements:
		var faces: Dictionary = element["faces"]
		for dir in faces:
			var face: Dictionary = faces[dir]
			if int(face.get("tint_index", -1)) >= 0:
				var key := str(face["texture_key"])
				tinted_counts[key] = int(tinted_counts.get(key, 0)) + 1
	if tinted_counts.is_empty():
		return
	# The biome color to apply: classify the most-used tinted texture's path.
	var main_key := ""
	var best := -1
	for key in tinted_counts:
		if tinted_counts[key] > best:
			best = tinted_counts[key]; main_key = key
	bt.tint = _classify_tint(main_key)["color"]
	for key in tinted_counts:
		var asset := _library.get_texture_asset(key)
		if asset != null and asset.tint_source == TextureAsset.TintSource.NONE:
			var cls := _classify_tint(key)
			asset.tint_source = cls["source"]
			asset.fixed_tint = cls["color"]
	if tinted_counts.has(_dominant_texture_key(model)):
		bt.color = bt.color * bt.tint

# Guess a tint category (+ plains color) from a texture ref's path. MC decides this
# in Java per block, so this path heuristic is the importer's best neutral stand-in;
# the result is only a default the user can override. Unknown tintindex content
# defaults to grass green (the most common case).
func _classify_tint(texture_ref: String) -> Dictionary:
	var path := str(_split_ref(texture_ref)["path"]).to_lower()
	if path.contains("water"):
		return {"source": TextureAsset.TintSource.FIXED, "color": _WATER_TINT}
	if path.contains("leaves") or path.contains("foliage") or path.contains("vine") or path.contains("lily"):
		return {"source": TextureAsset.TintSource.FOLIAGE, "color": _PLAINS_FOLIAGE}
	return {"source": TextureAsset.TintSource.GRASS, "color": _PLAINS_GRASS}

# ---------------------------------------------------------------------------
# Ref + path helpers
# ---------------------------------------------------------------------------

# Split "ns:path" → {ns, path}; a bare ref defaults to the "minecraft" namespace
# (MC's rule, applied identically for any mod's refs). Shared with the flat importer.
func _split_ref(ref: String) -> Dictionary:
	return MCTexImport.split_ref(ref)

# Canonical "ns:path" form of a ref, so the same model/texture deduplicates to one
# library id whether a pack wrote it bare or fully qualified. A bare ref defaults to
# "minecraft" — MC's rule, applied identically to every namespace (mods qualify their
# own refs, so a bare ref genuinely means vanilla). "" stays "".
func _canonical(ref: String) -> String:
	if ref.is_empty():
		return ""
	var sr := _split_ref(ref)
	return "%s:%s" % [sr["ns"], sr["path"]]

# Paths are relative to the assets root; the source resolves them to disk / zip.
func _blockstate_rel(ns: String, block_id: String) -> String:
	return "%s/blockstates/%s.json" % [ns, block_id]

func _model_rel(model_ref: String) -> String:
	var sr := _split_ref(model_ref)
	return "%s/models/%s.json" % [sr["ns"], sr["path"]]

func _read_json(rel: String):
	var text := _source.read_text(rel)
	if text.is_empty():
		return null
	return JSON.parse_string(text)

func _warn(msg: String) -> void:
	warnings.append(msg)
