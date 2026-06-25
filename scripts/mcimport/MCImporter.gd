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
#   var imp := MCImporter.new(assets_root, VoxelWorld.workspace)
#   imp.import_namespace("minecraft")      # or imp.import_all()
#   # → workspace libraries are filled in memory + pixels copied to disk;
#   # the caller persists with LibraryStore.save_all(workspace).
#
# `assets_root` is the directory that directly contains the namespace folders (the
# `assets/` dir of an unzipped resource pack or `.jar`). Reads go straight off disk
# (res://, user://, or an absolute OS path); writes go through AssetLibrary so the
# storage root stays the one swap point (decision 3).

# MC face / direction names, in BlockModel.Dir order (NORTH,EAST,SOUTH,WEST,UP,DOWN).
# Orientation.Facing shares the same ordering, so this one table serves both the
# model face directions and blockstate `facing=` values.
const _DIR6 := {
	"north": 0, "east": 1, "south": 2, "west": 3, "up": 4, "down": 5,
}

var _assets_root: String
var _workspace: VoxelWorkspace

# Per-run caches. Resolved model JSON is cached by ref so the shared MC templates
# (block/block, block/cube, block/cube_all, …) are parsed once even though hundreds
# of blocks inherit them. Model/texture dedup into the workspace itself.
var _resolved_cache := {}   # model ref -> { textures, elements, ao }

# Diagnostics the caller (and tests) can inspect after a run.
var imported_blocks: Array[String] = []
var warnings: Array[String] = []

func _init(assets_root: String, workspace: VoxelWorkspace) -> void:
	_assets_root = assets_root
	_workspace = workspace

# ---------------------------------------------------------------------------
# Entry points
# ---------------------------------------------------------------------------

# Import every namespace found directly under the assets root (the modded case).
func import_all() -> void:
	var dir := DirAccess.open(_assets_root)
	if dir == null:
		_warn("assets root not found: %s" % _assets_root)
		return
	for ns in dir.get_directories():
		import_namespace(ns)

# Import every block whose blockstate lives under `<ns>/blockstates/`.
func import_namespace(ns: String) -> void:
	var dir := DirAccess.open(_dir_path(ns, "blockstates"))
	if dir == null:
		_warn("no blockstates for namespace: %s" % ns)
		return
	for file_name in dir.get_files():
		if file_name.ends_with(".json"):
			import_block(ns, file_name.get_basename())

# Translate one block (its blockstate + every model/texture it references) into a
# BlockType in the workspace. Returns the BlockType, or null if it couldn't be read
# or used a form not handled yet (multipart → Phase 3). Idempotent by name.
func import_block(ns: String, block_id: String) -> BlockType:
	var bs = _read_json(_blockstate_file(ns, block_id))
	if bs == null:
		_warn("unreadable blockstate: %s:%s" % [ns, block_id])
		return null
	if bs.has("multipart"):
		return _import_multipart(ns, block_id, bs["multipart"])
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
	return _emit_block_type(block_id, state_map.default_model_id(), state_map)

# Translate an MC `multipart` blockstate (fences, panes, bars) into a multipart
# BlockStateMap. Each rule is { when?, apply }: `apply` names the model (+ optional
# x/y rotation), `when` the connection condition. Boolean direction conditions
# (north/east/…=true/false) are translated; multi-value vocabularies (walls'
# low/tall, redstone's side/up) are out of this phase — those parts are skipped
# (warned), so the block still imports with whatever parts we can render (at least
# the always-on post).
func _import_multipart(ns: String, block_id: String, multipart) -> BlockType:
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
	return _emit_block_type(block_id, state_map.default_part_model_id(), state_map)

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
func _emit_block_type(block_id: String, primary_ref: String, state_map: BlockStateMap) -> BlockType:
	var primary_model := _workspace.get_block_model(primary_ref)
	var bt := _workspace.get_block_type(block_id)
	if bt == null:
		bt = _workspace.add_block_type(block_id)
	bt.model_id = primary_ref
	bt.state_map = state_map
	var avg = _model_average_color(primary_model)
	if avg != null:
		bt.color = avg
	if not imported_blocks.has(block_id):
		imported_blocks.append(block_id)
	return bt

# ---------------------------------------------------------------------------
# Blockstate variants
# ---------------------------------------------------------------------------

# Flatten a `variants` dict into a list of {facing, top, model_ref, x, y, uvlock}.
# Properties voxyl doesn't model (shape=, waterlogged=, …) are dropped — the plan's
# "flatten unmodeled properties to a sensible default". A weighted-random variant
# (an array of models) takes the first.
func _parse_variants(variants) -> Array:
	var out: Array = []
	if not (variants is Dictionary):
		return out
	for state_str in variants.keys():
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
	var existing := _workspace.get_block_model(model_ref)
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
	_workspace.add_block_model(model)
	return model

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
	var j = _read_json(_model_file(model_ref))
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
			base["textures"][k] = str(j["textures"][k])
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
			out_elements.append({"from": from, "to": to, "faces": faces})
	var textures := {}
	for tid in used:
		textures[tid] = tid
	return {"elements": out_elements, "textures": textures}

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

# Ensure a TextureAsset exists for a texture ref, copying its PNG into the library
# and parsing any `.mcmeta` animation. Deduped by id (qualified ref). Returns null
# if the source PNG is missing/unreadable.
func _ensure_texture(texture_ref: String) -> TextureAsset:
	var sr := _split_ref(texture_ref)
	var id: String = "%s:%s" % [sr["ns"], sr["path"]]
	var existing := _workspace.get_texture_asset(id)
	if existing != null:
		return existing

	var src := _texture_file(texture_ref)
	var img := Image.new()
	if not FileAccess.file_exists(src) or img.load(src) != OK:
		_warn("texture image missing: %s" % texture_ref)
		return null

	# Copy pixels into the library (frame strips kept as-is). image_path is stored
	# library-relative so AssetLibrary resolves it under whatever ROOT is current.
	var rel := "%s/%s/%s.png" % [AssetLibrary.PIXELS_DIR, sr["ns"], sr["path"]]
	AssetLibrary.ensure_dir(rel.get_base_dir())
	img.save_png(AssetLibrary.path_for(rel))

	var asset := TextureAsset.new()
	asset.id = id
	asset.image_path = rel
	var scan := _scan_image(img)
	asset.average_color = scan["average"]
	asset.transparency = scan["transparency"]
	_apply_mcmeta(asset, src + ".mcmeta", img)
	_workspace.add_texture_asset(asset)
	return asset

# One pass over the pixels for both the planning color and a transparency class.
# average ignores (near-)transparent pixels so a glass/leaf border doesn't wash the
# color toward black. Partial alpha anywhere → TRANSLUCENT; only hard 0/1 alpha with
# some fully-transparent pixels → CUTOUT; otherwise OPAQUE.
func _scan_image(img: Image) -> Dictionary:
	var w := img.get_width()
	var h := img.get_height()
	var r := 0.0; var g := 0.0; var b := 0.0; var n := 0
	var has_transparent := false
	var has_partial := false
	for y in h:
		for x in w:
			var c := img.get_pixel(x, y)
			if c.a < 0.05:
				has_transparent = true
				continue
			if c.a < 0.95:
				has_partial = true
			r += c.r; g += c.g; b += c.b; n += 1
	var average := Color(0.5, 0.5, 0.5)
	if n > 0:
		average = Color(r / n, g / n, b / n)
	var transparency := TextureAsset.Transparency.OPAQUE
	if has_partial:
		transparency = TextureAsset.Transparency.TRANSLUCENT
	elif has_transparent:
		transparency = TextureAsset.Transparency.CUTOUT
	return {"average": average, "transparency": transparency}

# Parse an MC `.mcmeta` animation block onto the asset. MC stacks frames vertically
# as square tiles, so frame_count = height / width. frametime is in ticks → seconds
# (÷20, the render shader consumes seconds/frame directly — Phase 1 note).
func _apply_mcmeta(asset: TextureAsset, mcmeta_path: String, img: Image) -> void:
	var j = _read_json(mcmeta_path)
	if j == null or not j.has("animation"):
		return
	var anim = j["animation"]
	var w := maxi(img.get_width(), 1)
	asset.frame_count = maxi(1, floori(img.get_height() / float(w)))
	asset.frame_time = float(int(anim.get("frametime", 1))) / 20.0
	asset.interpolate = bool(anim.get("interpolate", false))
	if anim.has("frames"):
		var order: Array[int] = []
		for fr in anim["frames"]:
			if fr is Dictionary:
				order.append(int(fr.get("index", 0)))   # per-frame time ignored (Phase 2)
			else:
				order.append(int(fr))
		asset.frame_order = order

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
	if best_key.is_empty():
		best_key = model.textures.keys()[0]
	var asset := _workspace.get_texture_asset(model.textures.get(best_key, best_key))
	if asset != null:
		return asset.average_color
	return null

# ---------------------------------------------------------------------------
# Ref + path helpers
# ---------------------------------------------------------------------------

# Split "ns:path" → {ns, path}; a bare ref defaults to the "minecraft" namespace
# (MC's rule, applied identically for any mod's refs).
func _split_ref(ref: String) -> Dictionary:
	var colon := ref.find(":")
	if colon >= 0:
		return {"ns": ref.substr(0, colon), "path": ref.substr(colon + 1)}
	return {"ns": "minecraft", "path": ref}

# Canonical "ns:path" form of a ref, so the same model/texture deduplicates to one
# library id whether a pack wrote it bare or fully qualified. A bare ref defaults to
# "minecraft" — MC's rule, applied identically to every namespace (mods qualify their
# own refs, so a bare ref genuinely means vanilla). "" stays "".
func _canonical(ref: String) -> String:
	if ref.is_empty():
		return ""
	var sr := _split_ref(ref)
	return "%s:%s" % [sr["ns"], sr["path"]]

func _dir_path(ns: String, sub: String) -> String:
	return "%s/%s/%s" % [_assets_root, ns, sub]

func _blockstate_file(ns: String, block_id: String) -> String:
	return "%s/%s/blockstates/%s.json" % [_assets_root, ns, block_id]

func _model_file(model_ref: String) -> String:
	var sr := _split_ref(model_ref)
	return "%s/%s/models/%s.json" % [_assets_root, sr["ns"], sr["path"]]

func _texture_file(texture_ref: String) -> String:
	var sr := _split_ref(texture_ref)
	return "%s/%s/textures/%s.png" % [_assets_root, sr["ns"], sr["path"]]

func _read_json(abs_path: String):
	if not FileAccess.file_exists(abs_path):
		return null
	var f := FileAccess.open(abs_path, FileAccess.READ)
	if f == null:
		return null
	return JSON.parse_string(f.get_as_text())

func _warn(msg: String) -> void:
	warnings.append(msg)
