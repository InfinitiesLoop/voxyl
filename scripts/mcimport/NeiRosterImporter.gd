class_name NeiRosterImporter
extends RefCounted

# Reads NEI's own "Data Dumps" output into the confirmed, complete roster of everything
# placeable in a modpack — real registry name + meta + display name + mod, straight from the
# live Forge/NEI registry, never guessed — and replaces MCFlatImporter's texture-filename
# clustering as voxyl's pre-1.8 import path. General to any 1.7.10-1.12 modpack that ships
# NEI, not GTNH-specific.
#
# Two files from NEI's in-game Options → Tools → Data Dumps, both CSV:
#   item.csv:      Name, ID, Has Block, Mod, Class, Display Name — one row per REGISTERED
#                  Item object. Only its "Has Block" column and "Mod" label are used here
#                  (which registry names are placeable, and their human mod grouping).
#   itempanel.csv: Item Name, Item ID, Item meta, Has NBT, Display Name — dump mode "Item
#                  Panel". One row per REAL SUBTYPE (built from Item.getSubItems(), the same
#                  thing NEI's own browsable list shows) — this is what resolves meta-packed
#                  variants (e.g. Ztones "Korp ⓪".."Korp ⑮", metas 0-15) and things with no
#                  registry-level identity at all (GregTech single-block machines: one item id
#                  covers every tier/type, distinguished purely by this per-subtype meta).
# See .plans/prefabs.md for how this was confirmed against a real GTNH 2.9 dump.
#
# Texture attachment is a second, NARROW pass per confirmed entry (never a blind
# filename-clustering guess): given a real (registry, meta), search that mod's own
# textures/blocks/ for a file whose name correlates with the registry's local part, and for a
# meta-packed entry, whose own numeral correlates with the confirmed meta. No candidate, or an
# ambiguous one → the block type still exists, correctly identified, just textureless
# (principle 5 — undecided is always valid). This is deliberately narrower than
# MCFlatImporter's old block-BOUNDARY guessing (which produced "weird blocks that use textures
# in ways blocks never do") — the roster already gives the boundary; only the face-suffix
# detection (top/side/bottom/…) below is inherited from it, now applied only within an
# already-confirmed block's own candidate files, never to discover blocks in the first place.

const _ITEM_HEADER := ["Name", "ID", "Has Block", "Mod", "Class", "Display Name"]
const _ITEMPANEL_HEADER := ["Item Name", "Item ID", "Item meta", "Has NBT", "Display Name"]

var _library: BlockLibrary
var _sources_by_ns := {}     # lowercased real namespace -> MCAssetSource
var _real_ns_by_norm := {}   # _norm(real namespace) -> the real namespace string (see _norm)
var _by_identity := {}       # "registry@meta" -> existing BlockType (for idempotent reimport)
var _warned_missing_ns := {} # namespace -> true (warn once per mod, not once per row)

# The parsed roster: mod label -> Array of { registry, meta, mod, display, ns }.
var _rows_by_mod := {}
var mods: PackedStringArray = PackedStringArray()

# Diagnostics, mirroring the other importers so callers/tests treat them alike.
var imported_blocks: Array[String] = []
var warnings: Array[String] = []

func _init(sources: Array, library: BlockLibrary) -> void:
	_library = library
	for s in sources:
		for ns in s.list_namespaces():
			_sources_by_ns[ns.to_lower()] = s
			_real_ns_by_norm[_norm(ns)] = ns
	for bt in library.block_types:
		if McId.has_registry(bt):
			_by_identity["%s@%d" % [McId.get_registry(bt), McId.get_mc_meta(bt)]] = bt

# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

# Parse item.csv + itempanel.csv from `dumps_dir`. Returns "" on success, else a message
# describing what went wrong (missing file, unexpected header).
func load_dumps(dumps_dir: String) -> String:
	var placeable: Variant = _read_placeable(dumps_dir.path_join("item.csv"))
	if placeable is String:
		return placeable
	var rows: Variant = _read_item_panel(dumps_dir.path_join("itempanel.csv"))
	if rows is String:
		return rows
	_rows_by_mod.clear()
	var mod_set := {}
	for row: Dictionary in rows:
		var owner: Dictionary = placeable.get(str(row["registry"]), {})
		if owner.is_empty():
			continue   # itempanel.csv lists every item, not just placeable ones
		row["mod"] = owner["mod"]
		row["ns"] = owner["ns"]
		var mod: String = row["mod"]
		if not _rows_by_mod.has(mod):
			_rows_by_mod[mod] = []
		(_rows_by_mod[mod] as Array).append(row)
		mod_set[mod] = true
	mods = PackedStringArray(mod_set.keys())
	mods.sort()
	return ""

# registry -> {mod, ns}, for every item.csv row with Has Block == "true".
func _read_placeable(path: String):
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return "couldn't open %s — run NEI's Data Dumps (Items) first" % path
	var header := f.get_csv_line()
	if Array(header) != _ITEM_HEADER:
		return "%s doesn't look like an NEI item dump (unexpected header)" % path
	var out := {}
	while not f.eof_reached():
		var row := f.get_csv_line()
		if row.size() < 6 or str(row[0]).is_empty():
			continue
		if str(row[2]) != "true":
			continue
		var registry := str(row[0])
		out[registry] = {"mod": str(row[3]), "ns": MCTexImport.split_ref(registry)["ns"]}
	return out

# Array of { registry, meta, display }, one per itempanel.csv row (mod/ns filled in by
# load_dumps once cross-referenced against the placeable set).
func _read_item_panel(path: String):
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return "couldn't open %s — run NEI's Data Dumps (Item Panel, CSV mode) first" % path
	var header := f.get_csv_line()
	if Array(header) != _ITEMPANEL_HEADER:
		return "%s doesn't look like an NEI Item Panel dump (unexpected header)" % path
	var out: Array = []
	while not f.eof_reached():
		var row := f.get_csv_line()
		if row.size() < 5 or str(row[0]).is_empty():
			continue
		if not str(row[2]).is_valid_int():
			continue
		out.append({"registry": str(row[0]), "meta": int(row[2]), "display": str(row[4])})
	return out

# ---------------------------------------------------------------------------
# Browse
# ---------------------------------------------------------------------------

# The asset source backing a namespace, or null — lets a caller (ImportService, wiring the
# post-import extension pass) find the same source this importer's texture-attachment used.
func source_for(ns: String) -> MCAssetSource:
	return _resolve_source(ns).get("source")

# {source, ns} for a namespace, or {} if none matches — tried exact first, then normalized
# (letters+digits only, case-insensitive). Many older 1.7.10 mods register blocks under their
# raw @Mod modid ("BuildCraft|Core", "AWWayofTime"), which isn't a legal resource-folder name;
# the real assets/ folder is a sanitized version ("buildcraftcore"). Returning the REAL
# namespace (not just the source) matters — callers build texture paths from it.
func _resolve_source(ns: String) -> Dictionary:
	if _sources_by_ns.has(ns.to_lower()):
		return {"source": _sources_by_ns[ns.to_lower()], "ns": ns}
	var real: String = _real_ns_by_norm.get(_norm(ns), "")
	if real.is_empty():
		return {}
	return {"source": _sources_by_ns[real.to_lower()], "ns": real}

# Letters and digits only, lowercased — collapses "BuildCraft|Core" and "buildcraftcore" (or
# "AWWayofTime" and "aw_way_of_time") to the same key.
static func _norm(s: String) -> String:
	var out := ""
	for ch in s.to_lower():
		if (ch >= "a" and ch <= "z") or (ch >= "0" and ch <= "9"):
			out += ch
	return out

func entries(mod: String) -> Array:
	return _rows_by_mod.get(mod, [])

# Every roster row, across every mod — for browsing/search without picking a mod first.
func all_entries() -> Array:
	var out: Array = []
	for mod in mods:
		out.append_array(entries(mod))
	return out

# ---------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------

# Create/update the BlockType for one roster row (confirmed identity, best-effort texture).
# Idempotent: reimporting the same (registry, meta) reuses the existing BlockType.
func import_entry(row: Dictionary) -> BlockType:
	var registry := str(row["registry"])
	var meta := int(row["meta"])
	var key := "%s@%d" % [registry, meta]
	var bt: BlockType = _by_identity.get(key)
	if bt == null:
		bt = _library.add_block_type(_unique_name(row))
		_by_identity[key] = bt
	McId.set_registry_id(bt, registry, meta, McId.get_orient(bt), true, str(row["mod"]), str(row["display"]))
	bt.source_namespace = str(row["ns"])
	_attach_texture(bt, row)
	if not imported_blocks.has(bt.name):
		imported_blocks.append(bt.name)
	return bt

func _unique_name(row: Dictionary) -> String:
	var display := str(row["display"])
	var base := display if not display.is_empty() else str(row["registry"])
	var candidate := base
	var n := 2
	while _library.get_block_type(candidate) != null:
		candidate = "%s (%d)" % [base, n]
		n += 1
	return candidate

# ---------------------------------------------------------------------------
# Texture attachment — narrow, per-confirmed-entry matching (see class doc comment)
# ---------------------------------------------------------------------------

# Face token → the directions it fills (same vocabulary MCFlatImporter used; kept here since
# it's genuinely reusable within one already-known block's own file family).
const _N := BlockModel.Dir.NORTH
const _E := BlockModel.Dir.EAST
const _S := BlockModel.Dir.SOUTH
const _W := BlockModel.Dir.WEST
const _U := BlockModel.Dir.UP
const _D := BlockModel.Dir.DOWN
const _HORIZ := [_N, _E, _S, _W]
const _FACE := {
	"top": [_U], "up": [_U], "bottom": [_D], "down": [_D], "bot": [_D],
	"side": _HORIZ, "sides": _HORIZ, "front": [_N], "facing": [_N],
	"back": [_S], "rear": [_S], "left": [_W], "right": [_E],
	"north": [_N], "south": [_S], "east": [_E], "west": [_W],
	"end": [_U, _D], "ends": [_U, _D], "cap": [_U, _D],
}
const _STATES := {
	"on": true, "off": true, "active": true, "inactive": true, "lit": true, "unlit": true,
}

func _attach_texture(bt: BlockType, row: Dictionary) -> void:
	var ns := str(row["ns"])
	var resolved := _resolve_source(ns)
	if resolved.is_empty():
		resolved = _resolve_source(str(row["mod"]))   # second guess: NEI's own mod label
	if resolved.is_empty():
		if not _warned_missing_ns.has(ns):
			_warned_missing_ns[ns] = true
			warnings.append("no assets found for mod namespace '%s' — its blocks import textureless" % ns)
		return
	var source: MCAssetSource = resolved["source"]
	var real_ns: String = resolved["ns"]
	var base_token := _base_token(str(row["registry"]))
	if base_token.is_empty():
		return
	var candidates := _matching_files(source, real_ns, base_token)
	if candidates.is_empty():
		return
	var faces := _resolve_faces(candidates, int(row["meta"]))
	if faces.is_empty():
		return
	_bind_model(bt, real_ns, source, faces)

# "tile.korpBlock" -> "korp"; "gt.blockmachines" -> "blockmachines". Strips a leading "tile."
# and a trailing "block"/"blocks", case-insensitively — the common ztones/vanilla-ish pattern;
# anything else is left as the lowercased local name (still a reasonable substring anchor).
func _base_token(registry: String) -> String:
	var local: String = MCTexImport.split_ref(registry)["path"]
	local = local.to_lower()
	if local.begins_with("tile."):
		local = local.substr(5)
	for suffix in ["blocks", "block"]:
		if local.ends_with(suffix) and local.length() > suffix.length():
			local = local.substr(0, local.length() - suffix.length())
			break
	return local

# Every texture file under the namespace's textures/blocks (recursively; ztones-style sorts
# into subfolders) whose basename contains `base_token` as a token.
func _matching_files(source: MCAssetSource, ns: String, base_token: String) -> Array:
	var files := source.list_files_recursive("%s/textures/blocks" % ns)
	var subdir := "blocks"
	if files.is_empty():
		files = source.list_files_recursive("%s/textures/block" % ns)   # rare 1.7.10 variant
		subdir = "block"
	var out: Array = []
	for f in files:
		if not f.ends_with(".png"):
			continue
		var name := f.get_basename()
		var toks := _tokenize(name.get_file())   # match against the leaf name, not the subpath
		if toks.find(base_token) >= 0 or String(",".join(toks)).contains(base_token):
			out.append({"name": name, "subdir": subdir, "toks": toks})
	return out

# Split candidates into a numeral-suffixed group (meta variants) and a face-suffixed / plain
# group (one block's own faces), then resolve to a dir->filename map for `meta`, or {} if
# nothing confidently matches. Mirrors MCFlatImporter's face grouping, but scoped to files
# already known to belong to this one confirmed block.
func _resolve_faces(candidates: Array, meta: int) -> Dictionary:
	var numbered := {}     # int -> candidate (only when exactly one file carries that number)
	var seen_numbers := {}
	for c: Dictionary in candidates:
		var n := _trailing_number(c["toks"])
		if n < 0:
			continue
		if seen_numbers.has(n):
			seen_numbers[n] = null   # ambiguous — more than one file for this number
		else:
			seen_numbers[n] = c
	for n in seen_numbers:
		if seen_numbers[n] != null:
			numbered[n] = seen_numbers[n]
	if not numbered.is_empty():
		if not numbered.has(meta):
			return {}   # meta-packed, but nothing confidently maps to THIS meta
		var c: Dictionary = numbered[meta]
		return {_U: c, _D: c, _N: c, _S: c, _E: c, _W: c}
	# Not meta-packed (no numeral-suffixed files at all): face-bind the plain candidates.
	var face_map := {}
	var wholes: Array = []
	for c: Dictionary in candidates:
		var face := _face_of(c["toks"])
		if face.is_empty():
			wholes.append(c)
		elif not face_map.has(face):
			face_map[face] = c
	if face_map.is_empty() and wholes.size() != 1:
		return {}   # zero or ambiguously-many plain matches
	var out := {}
	var tokens := face_map.keys()
	tokens.sort_custom(func(a, b): return _FACE[a].size() < _FACE[b].size())
	for token in tokens:
		for d in _FACE[token]:
			if not out.has(d):
				out[d] = face_map[token]
	var default = wholes[0] if not wholes.is_empty() else face_map.values()[0]
	for d in [_U, _D, _N, _S, _E, _W]:
		if not out.has(d):
			out[d] = default
	return out

func _bind_model(bt: BlockType, ns: String, source: MCAssetSource, faces: Dictionary) -> void:
	var model_faces := {}
	var textures := {}
	for d in faces:
		var c: Dictionary = faces[d]
		var asset := MCTexImport.ensure_texture(_library, source, "%s:%s/%s" % [ns, c["subdir"], c["name"]], warnings)
		if asset == null:
			continue
		model_faces[d] = BlockModel.make_face(asset.id)
		textures[asset.id] = asset.id
	if model_faces.is_empty():
		return
	var model_id := "%s:nei/%s" % [ns, bt.name]
	var model := _library.get_block_model(model_id)
	if model == null:
		model = BlockModel.new()
		model.id = model_id
		_library.add_block_model(model)
	model.elements = [{"from": Vector3.ZERO, "to": Vector3.ONE, "faces": model_faces}]
	model.textures = textures
	bt.model_id = model_id
	var dom: String = textures.keys()[0] if not textures.is_empty() else ""
	var da := _library.get_texture_asset(dom) if not dom.is_empty() else null
	if da != null:
		bt.color = da.average_color

# The trailing integer in a tokenized filename ("korp_ (4)" -> ["korp","4"] -> 4), or -1 when
# the name carries no number. A face word alone (no digit) isn't a meta index.
func _trailing_number(toks: PackedStringArray) -> int:
	if toks.is_empty():
		return -1
	var last := toks[toks.size() - 1]
	return int(last) if last.is_valid_int() else -1

# The single face token a tokenized name ends with, once a trailing number and known state
# words are stripped, or "" when none is found (a plain/whole-block texture).
func _face_of(toks: PackedStringArray) -> String:
	var t := toks.duplicate()
	while not t.is_empty() and (t[t.size() - 1].is_valid_int() or _STATES.has(t[t.size() - 1])):
		t.remove_at(t.size() - 1)
	if t.is_empty():
		return ""
	var last: String = t[t.size() - 1]
	return last if _FACE.has(last) else ""

# Split a name into lowercase tokens on '_', '.', '-', ' ', '(', ')' and camelCase boundaries.
func _tokenize(name: String) -> PackedStringArray:
	var out := PackedStringArray()
	var cur := ""
	var prev_lower := false
	for i in name.length():
		var ch := name[i]
		if ch == "_" or ch == "." or ch == "-" or ch == " " or ch == "(" or ch == ")":
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
