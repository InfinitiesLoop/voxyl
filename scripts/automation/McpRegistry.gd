class_name McpRegistry
extends RefCounted

# The agent tool catalog: each tool is a name, a description, a JSON Schema for its
# arguments and a handler (a Callable taking the arguments Dictionary; it may await).
# tools/list is generated straight from here, so the catalog can't drift from the code.
#
# Handlers return a Dictionary of result data. Two reserved keys:
#   ERROR_KEY  — { code, message, ... }: the call failed (fail() builds it)
#   IMAGES_KEY — MCP image content blocks to send after the JSON text (image() builds one)
# Vectors and other engine types in the result are converted to plain JSON (to_json).
#
# Tool groups live in scripts/automation/tools/, one file per area, each with a static
# register(reg). An optional extension (like mcimport) can register its own group the same
# way, so core never has to name it.

const ERROR_KEY := "__error"
const IMAGES_KEY := "__images"

const _GROUPS := [
	preload("res://scripts/automation/tools/SessionTools.gd"),
	preload("res://scripts/automation/tools/LibraryTools.gd"),
	preload("res://scripts/automation/tools/PaletteTools.gd"),
	preload("res://scripts/automation/tools/ShapeTools.gd"),
	preload("res://scripts/automation/tools/ProjectTools.gd"),
	preload("res://scripts/automation/tools/EditTools.gd"),
	preload("res://scripts/automation/tools/PrefabTools.gd"),
	preload("res://scripts/automation/tools/InspectTools.gd"),
	preload("res://scripts/automation/tools/ViewTools.gd"),
]

var _tools := {}
var _order: Array[String] = []

func register_all() -> void:
	for g in _GROUPS:
		g.register(self)

# Register a tool. opts: mutates (edits the build or workspace; paused/queued behind the
# user), title.
func add(name: String, description: String, schema: Dictionary, handler: Callable, opts := {}) -> void:
	if not _tools.has(name):
		_order.append(name)
	var s := schema.duplicate(true)
	s["type"] = "object"
	if not s.has("properties"):
		s["properties"] = {}
	_tools[name] = {
		"name": name,
		"description": description,
		"schema": s,
		"handler": handler,
		"mutates": bool(opts.get("mutates", false)),
		"title": str(opts.get("title", "")),
	}

func get_tool(name: String) -> Dictionary:
	return _tools.get(name, {})

func names() -> Array[String]:
	return _order.duplicate()

func list_tools() -> Array:
	var out: Array = []
	for n in _order:
		var t: Dictionary = _tools[n]
		var d := {"name": n, "description": t["description"], "inputSchema": t["schema"]}
		if not str(t["title"]).is_empty():
			d["title"] = t["title"]
		var ann := {"readOnlyHint": not t["mutates"]}
		d["annotations"] = ann
		out.append(d)
	return out

# Call a tool directly (tests, and tools that compose others). Same result shape as a handler.
func call_tool(name: String, args := {}) -> Variant:
	var t := get_tool(name)
	if t.is_empty():
		return fail("unknown_tool", name)
	return await (t["handler"] as Callable).call(args)

# --- Result helpers ----------------------------------------------------------------

static func fail(code: String, message: String, extra := {}) -> Dictionary:
	var e := {"code": code, "message": message}
	e.merge(extra)
	return {ERROR_KEY: e}

static func is_error(r: Variant) -> bool:
	return r is Dictionary and (r as Dictionary).has(ERROR_KEY)

# An MCP image content block for an Image (PNG, or JPEG when asked).
static func image(img: Image, format := "png") -> Dictionary:
	var bytes: PackedByteArray
	var mime := "image/png"
	if format == "jpeg" or format == "jpg":
		bytes = img.save_jpg_to_buffer(0.88)
		mime = "image/jpeg"
	else:
		bytes = img.save_png_to_buffer()
	return {"type": "image", "data": Marshalls.raw_to_base64(bytes), "mimeType": mime}

# Engine values → plain JSON values (vectors as arrays, colors as hex, whole floats as ints).
static func to_json(v: Variant) -> Variant:
	match typeof(v):
		TYPE_VECTOR3I, TYPE_VECTOR3:
			return [to_json(v.x), to_json(v.y), to_json(v.z)]
		TYPE_VECTOR2I, TYPE_VECTOR2:
			return [to_json(v.x), to_json(v.y)]
		TYPE_COLOR:
			return "#" + (v as Color).to_html(false)
		TYPE_FLOAT:
			var f: float = v
			if is_equal_approx(f, roundf(f)) and absf(f) < 1e15:
				return int(f)
			return snappedf(f, 0.0001)
		TYPE_DICTIONARY:
			var d := {}
			for k in v:
				d[str(k)] = to_json(v[k])
			return d
		TYPE_ARRAY, TYPE_PACKED_STRING_ARRAY, TYPE_PACKED_INT32_ARRAY, TYPE_PACKED_FLOAT32_ARRAY:
			var a: Array = []
			for x in v:
				a.append(to_json(x))
			return a
		TYPE_STRING_NAME:
			return str(v)
		TYPE_OBJECT:
			return str(v)
	return v
