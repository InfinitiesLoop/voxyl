class_name MCFlatImporter
extends RefCounted

# The PRE-1.8 Minecraft → voxyl translator. Before MC 1.8 there were no blockstate
# or model JSONs — blocks were drawn by Java code — so a 1.7.10 mod jar ships only
# loose block textures under `assets/<ns>/textures/blocks/*.png`, with no geometry or
# face mapping recorded anywhere. This importer is the honest best-effort for that
# era: it reads those PNGs and synthesizes voxyl's neutral material layer
# (BlockModel + TextureAsset + BlockType), every block a unit cube.
#
# "Smarter than always a cube": block textures of the 1.8+ era and many 1.7.10 mods
# follow vanilla's face-naming convention — `<base>_top` / `_bottom` / `_side` /
# `_front`, with the separator varying by mod (underscore in Thaumcraft, dot in
# Railcraft, camelCase in EnderIO). We tokenize each name, strip state words
# (on/off/active/filled/digits…), detect a trailing face token, and group textures
# that share a base into ONE multi-face cube — but only when the grouping is
# corroborated (≥2 distinct faces, or a face plus a plain texture). A lone suffixed
# texture or a plain texture stays its own uniform cube, so we never invent a block
# from a coincidence. It's a heuristic, surfaced as such in the UI; the shapes (slab,
# stairs, fence, cross…) simply aren't in the assets, so we don't pretend to know them.
#
# It is a reader of the user's own assets, never a content source (decision 4), and
# shares texture ingestion with MCImporter via MCTexImport so pixels/animation behave
# identically across both formats. The core stays MC-free — this is a plugin on top.

const _N := BlockModel.Dir.NORTH
const _E := BlockModel.Dir.EAST
const _S := BlockModel.Dir.SOUTH
const _W := BlockModel.Dir.WEST
const _U := BlockModel.Dir.UP
const _D := BlockModel.Dir.DOWN
const _HORIZ := [_N, _E, _S, _W]

# Face token → the directions it fills. Resting facing = NORTH (-Z), so front→NORTH.
# `side` fills the four horizontals; `end`/`cap` fill both caps (logs, cylinders).
const _FACE := {
	"top": [_U], "up": [_U],
	"bottom": [_D], "down": [_D], "bot": [_D],
	"side": _HORIZ, "sides": _HORIZ,
	"front": [_N], "facing": [_N],
	"back": [_S], "rear": [_S],
	"left": [_W], "right": [_E],
	"north": [_N], "south": [_S], "east": [_E], "west": [_W],
	"end": [_U, _D], "ends": [_U, _D], "cap": [_U, _D],
}

# State words a face texture may be suffixed with (machine on/off, lit, filled…).
# Stripped before face detection so `furnace_front_off` reads as the `front` face.
const _STATES := {
	"on": true, "off": true, "active": true, "inactive": true, "lit": true,
	"unlit": true, "powered": true, "unpowered": true, "filled": true,
	"empty": true, "open": true, "closed": true,
}

# Face words long/unambiguous enough to detect when glued with no separator and no
# camelCase boundary (e.g. `arcaneearbelltop`). Longest-first so "bottom" wins over
# nothing and we never clip a real word like "...side" off something shorter.
const _GLUED_FACES := ["bottom", "facing", "front", "sides", "back", "side", "top"]

var _source: MCAssetSource
var _library: BlockLibrary

# ns -> { "subdir": "blocks"|"block", "blocks": { block_id -> {dir:int -> filename} } }
var _plan_cache := {}

# Diagnostics, mirroring MCImporter so callers (ImportService) treat both alike.
var imported_blocks: Array[String] = []
var warnings: Array[String] = []

func _init(source, library: BlockLibrary) -> void:
	_source = source if source is MCAssetSource else MCDirSource.new(source)
	_library = library

# ---------------------------------------------------------------------------
# Browse
# ---------------------------------------------------------------------------

func list_namespaces() -> PackedStringArray:
	return _source.list_namespaces()

# The synthesized block ids for a namespace (grouped bases + standalone textures).
func list_blocks(ns: String) -> PackedStringArray:
	var keys := PackedStringArray()
	for k in _plans(ns)["blocks"].keys():
		keys.append(k)
	keys.sort()
	return keys

# ---------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------

func import_all() -> void:
	for ns in _source.list_namespaces():
		import_namespace(ns)

func import_namespace(ns: String) -> void:
	for block_id in list_blocks(ns):
		import_block(ns, block_id)

# Synthesize one block: import its face textures, build a unit-cube BlockModel with
# the per-face bindings, and emit the BlockType. `name_override` lets the import
# service dedup names across namespaces; "" keeps the synthesized id.
func import_block(ns: String, block_id: String, name_override := "") -> BlockType:
	var plan = _plans(ns)
	var blocks: Dictionary = plan["blocks"]
	if not blocks.has(block_id):
		_warn("no flat texture for block: %s:%s" % [ns, block_id])
		return null
	var subdir: String = plan["subdir"]
	var face_plan: Dictionary = blocks[block_id]

	var faces := {}
	var textures := {}
	var counts := {}
	for d in BlockModel.ALL_DIRS:
		var filename: String = face_plan[d]
		var asset := MCTexImport.ensure_texture(
			_library, _source, "%s:%s/%s" % [ns, subdir, filename], warnings)
		if asset == null:
			continue
		faces[d] = BlockModel.make_face(asset.id)
		textures[asset.id] = asset.id
		counts[asset.id] = int(counts.get(asset.id, 0)) + 1
	if faces.is_empty():
		_warn("flat block had no loadable textures: %s:%s" % [ns, block_id])
		return null

	var model_id := "%s:flat/%s" % [ns, block_id]
	var model := _library.get_block_model(model_id)
	if model == null:
		model = BlockModel.new()
		model.id = model_id
		_library.add_block_model(model)
	model.elements = [{"from": Vector3.ZERO, "to": Vector3.ONE, "faces": faces}]
	model.textures = textures

	var bt_name := name_override if not name_override.is_empty() else block_id
	var bt := _library.get_block_type(bt_name)
	if bt == null:
		bt = _library.add_block_type(bt_name)
	bt.model_id = model_id
	bt.state_map = null
	var dom := _dominant(counts)
	var da := _library.get_texture_asset(dom)
	if da != null:
		bt.color = da.average_color
	if not imported_blocks.has(bt_name):
		imported_blocks.append(bt_name)
	return bt

# ---------------------------------------------------------------------------
# Grouping / planning
# ---------------------------------------------------------------------------

# Build (and cache) the per-namespace plan: which texture files map to which block,
# and which face of it. See the class header for the heuristic.
func _plans(ns: String) -> Dictionary:
	if _plan_cache.has(ns):
		return _plan_cache[ns]
	var subdir := "blocks"
	var files := _source.list_files("%s/textures/blocks" % ns)
	if files.is_empty():
		files = _source.list_files("%s/textures/block" % ns)   # rare 1.7.10 variant
		subdir = "block"
	var plan := {"subdir": subdir, "blocks": _build_blocks(files)}
	_plan_cache[ns] = plan
	return plan

# Group the PNG basenames into block plans (block_id -> {dir -> filename}).
func _build_blocks(files: PackedStringArray) -> Dictionary:
	# base_key -> { "faces": {token -> filename}, "wholes": [filename] }
	var groups := {}
	for f in files:
		if not f.ends_with(".png"):
			continue
		var name := f.get_basename()
		var c := _classify(name)
		var key: String = c["base"]
		if not groups.has(key):
			groups[key] = {"faces": {}, "wholes": []}
		var g: Dictionary = groups[key]
		if c["face"].is_empty():
			(g["wholes"] as Array).append(name)
		else:
			var f_map: Dictionary = g["faces"]
			# Keep the lexicographically smallest filename per face — a deterministic,
			# "resting state" preference (e.g. `_off` before `_on`).
			if not f_map.has(c["face"]) or name < f_map[c["face"]]:
				f_map[c["face"]] = name

	var blocks := {}
	for key in groups:
		var g: Dictionary = groups[key]
		var face_map: Dictionary = g["faces"]
		var wholes: Array = g["wholes"]
		var multiface: bool = face_map.size() >= 2 or (face_map.size() >= 1 and not wholes.is_empty())
		if multiface:
			blocks[key] = _assemble(face_map, wholes)
		else:
			# Not corroborated — emit each member as its own uniform cube, named by its
			# actual filename so we never imply a fuller block than the asset supports.
			for fn in wholes:
				blocks[fn] = _uniform(fn)
			for token in face_map:
				var fn: String = face_map[token]
				blocks[fn] = _uniform(fn)
	return blocks

# Decompose a texture name into { base, face }. base is a normalized grouping key
# (lowercased, '_'-joined); face is "" when no face token is found.
func _classify(name: String) -> Dictionary:
	var toks := _tokenize(name)
	var last := toks.size()
	# Strip up to two trailing state / numeric tokens.
	var stripped := 0
	while last > 1 and stripped < 2 and (_STATES.has(toks[last - 1]) or toks[last - 1].is_valid_int()):
		last -= 1
		stripped += 1
	# A trailing face token (only when something remains before it).
	if last > 1 and _FACE.has(toks[last - 1]):
		var face := toks[last - 1]
		return {"base": _join(toks, last - 1), "face": face}
	# All-lowercase glued fallback (no separators, no camelCase): single token that
	# ends with a clear face word.
	if toks.size() == 1 and stripped == 0:
		var single := toks[0]
		for fw in _GLUED_FACES:
			if single.length() > fw.length() + 2 and single.ends_with(fw):
				return {"base": single.substr(0, single.length() - fw.length()), "face": fw}
	return {"base": _join(toks, last), "face": ""}

# Assemble a 6-face cube from detected faces, filling gaps from a sensible default.
func _assemble(face_map: Dictionary, wholes: Array) -> Dictionary:
	var out := {}
	# Apply specific (single-dir) tokens before broad ones (`side`, `end`) so a `front`
	# wins NORTH over a `side`.
	var tokens := face_map.keys()
	tokens.sort_custom(func(a, b): return _FACE[a].size() < _FACE[b].size())
	for token in tokens:
		for d in _FACE[token]:
			if not out.has(d):
				out[d] = face_map[token]
	var default: String = _default_tex(face_map, wholes)
	for d in BlockModel.ALL_DIRS:
		if not out.has(d):
			out[d] = default
	return out

func _uniform(filename: String) -> Dictionary:
	var out := {}
	for d in BlockModel.ALL_DIRS:
		out[d] = filename
	return out

# The texture used for any unmapped face: a plain texture if the group has one, else
# the most representative face (side > top > bottom > whatever is present).
func _default_tex(face_map: Dictionary, wholes: Array) -> String:
	if not wholes.is_empty():
		return (wholes as Array).min()
	for token in ["side", "sides", "top", "up", "bottom", "down", "front", "facing"]:
		if face_map.has(token):
			return face_map[token]
	return face_map.values()[0]

# ---------------------------------------------------------------------------
# Tokenizing
# ---------------------------------------------------------------------------

# Split a name into lowercase tokens on '_', '.', '-', ' ', and camelCase boundaries
# ("solarPanelSide" → [solar, panel, side]). Keeps consecutive capitals together.
func _tokenize(name: String) -> PackedStringArray:
	var out := PackedStringArray()
	var cur := ""
	var prev_lower := false
	for i in name.length():
		var ch := name[i]
		if ch == "_" or ch == "." or ch == "-" or ch == " ":
			if cur != "":
				out.append(cur.to_lower())
				cur = ""
			prev_lower = false
			continue
		var is_upper := ch >= "A" and ch <= "Z"
		if is_upper and prev_lower and cur != "":
			out.append(cur.to_lower())
			cur = ""
		cur += ch
		prev_lower = (ch >= "a" and ch <= "z") or (ch >= "0" and ch <= "9")
	if cur != "":
		out.append(cur.to_lower())
	return out

func _join(toks: PackedStringArray, count: int) -> String:
	var parts := PackedStringArray()
	for i in count:
		parts.append(toks[i])
	return "_".join(parts) if not parts.is_empty() else ""

# ---------------------------------------------------------------------------
# Misc
# ---------------------------------------------------------------------------

# The texture id bound to the most faces — the block's "main" texture for the
# planning color (mirrors MCImporter._dominant_texture_key).
func _dominant(counts: Dictionary) -> String:
	var best_key := ""
	var best := -1
	for key in counts:
		if counts[key] > best:
			best = counts[key]
			best_key = key
	return best_key

func _warn(msg: String) -> void:
	warnings.append(msg)
