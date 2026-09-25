class_name NbtWriter
extends RefCounted

# Minimal big-endian NBT writer, no Minecraft-specific knowledge (that's SchematicaWriter's
# job) — just the container format Schematica (and every other MC data file) uses: a
# gzip-compressed stream whose root is one named TAG_Compound.
#
# A tag is a plain Dictionary {type: TYPE_*, value: ...}, built via the tag_* helpers below
# rather than as raw dictionaries at call sites, so a typo in "type" fails in one place. A
# TAG_Compound's value is a Dictionary[String, Dictionary] (field name -> tag); a TAG_List's
# value is an Array of items, with item_type recording what they are (see tag_list()).

const TYPE_END := 0
const TYPE_BYTE := 1
const TYPE_SHORT := 2
const TYPE_INT := 3
const TYPE_LONG := 4
const TYPE_FLOAT := 5
const TYPE_DOUBLE := 6
const TYPE_BYTE_ARRAY := 7
const TYPE_STRING := 8
const TYPE_LIST := 9
const TYPE_COMPOUND := 10
const TYPE_INT_ARRAY := 11

static func tag_byte(v: int) -> Dictionary:
	return {"type": TYPE_BYTE, "value": v}

static func tag_short(v: int) -> Dictionary:
	return {"type": TYPE_SHORT, "value": v}

static func tag_int(v: int) -> Dictionary:
	return {"type": TYPE_INT, "value": v}

static func tag_long(v: int) -> Dictionary:
	return {"type": TYPE_LONG, "value": v}

static func tag_float(v: float) -> Dictionary:
	return {"type": TYPE_FLOAT, "value": v}

static func tag_double(v: float) -> Dictionary:
	return {"type": TYPE_DOUBLE, "value": v}

static func tag_string(v: String) -> Dictionary:
	return {"type": TYPE_STRING, "value": v}

static func tag_byte_array(v: PackedByteArray) -> Dictionary:
	return {"type": TYPE_BYTE_ARRAY, "value": v}

static func tag_int_array(v: PackedInt32Array) -> Dictionary:
	return {"type": TYPE_INT_ARRAY, "value": v}

static func tag_compound(v: Dictionary = {}) -> Dictionary:
	return {"type": TYPE_COMPOUND, "value": v}

# `items`: for item_type == TYPE_COMPOUND, an Array of Dictionary[String, tag] (a compound's
# own fields, unwrapped — list entries have no name/header of their own). For any other
# item_type, an Array of raw values (ints, strings, ...).
static func tag_list(item_type: int, items: Array) -> Dictionary:
	return {"type": TYPE_LIST, "item_type": item_type, "value": items}

# Serialize `fields` (as a TAG_Compound's value: Dictionary[String, tag]) as a complete,
# gzip-compressed NBT file: a single named root TAG_Compound. Schematica itself names its
# root "Schematic".
static func write_file(root_name: String, fields: Dictionary) -> PackedByteArray:
	var buf := StreamPeerBuffer.new()
	buf.big_endian = true
	_write_tag_header(buf, TYPE_COMPOUND, root_name)
	_write_compound_body(buf, fields)
	return buf.data_array.compress(FileAccess.COMPRESSION_GZIP)

static func _write_tag_header(buf: StreamPeerBuffer, type: int, name: String) -> void:
	buf.put_u8(type)
	var name_bytes := name.to_utf8_buffer()
	buf.put_u16(name_bytes.size())
	buf.put_data(name_bytes)

static func _write_compound_body(buf: StreamPeerBuffer, fields: Dictionary) -> void:
	for key in fields:
		var t: Dictionary = fields[key]
		_write_tag_header(buf, int(t["type"]), str(key))
		_write_payload(buf, t)
	buf.put_u8(TYPE_END)

static func _write_payload(buf: StreamPeerBuffer, tag: Dictionary) -> void:
	var type: int = tag["type"]
	match type:
		TYPE_BYTE:
			buf.put_8(int(tag["value"]))
		TYPE_SHORT:
			buf.put_16(int(tag["value"]))
		TYPE_INT:
			buf.put_32(int(tag["value"]))
		TYPE_LONG:
			buf.put_64(int(tag["value"]))
		TYPE_FLOAT:
			buf.put_float(float(tag["value"]))
		TYPE_DOUBLE:
			buf.put_double(float(tag["value"]))
		TYPE_BYTE_ARRAY:
			var arr: PackedByteArray = tag["value"]
			buf.put_32(arr.size())
			buf.put_data(arr)
		TYPE_STRING:
			var bytes: PackedByteArray = str(tag["value"]).to_utf8_buffer()
			buf.put_u16(bytes.size())
			buf.put_data(bytes)
		TYPE_LIST:
			var item_type: int = tag.get("item_type", TYPE_END)
			var items: Array = tag["value"]
			buf.put_u8(item_type)
			buf.put_32(items.size())
			for item in items:
				if item_type == TYPE_COMPOUND:
					_write_compound_body(buf, item)
				else:
					_write_payload(buf, {"type": item_type, "value": item})
		TYPE_COMPOUND:
			_write_compound_body(buf, tag["value"])
		TYPE_INT_ARRAY:
			var iarr: PackedInt32Array = tag["value"]
			buf.put_32(iarr.size())
			for v in iarr:
				buf.put_32(v)
