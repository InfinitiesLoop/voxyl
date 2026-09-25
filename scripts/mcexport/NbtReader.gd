class_name NbtReader
extends RefCounted

# Minimal big-endian NBT reader (gzip input) — the mirror of NbtWriter, for SchematicaProbe's
# read-only round-trip diagnostic. Returns tags in the same {type, value} shape NbtWriter's
# tag_* helpers build (plus item_type on a TAG_List), so a probe can inspect them directly.

const _MAX_UNCOMPRESSED := 64 * 1024 * 1024

# {name, value} for the file's root TAG_Compound (value: Dictionary[String, tag]), or null if
# `bytes` isn't valid gzip-compressed NBT.
static func read_file(bytes: PackedByteArray) -> Variant:
	var raw := bytes.decompress_dynamic(_MAX_UNCOMPRESSED, FileAccess.COMPRESSION_GZIP)
	if raw.is_empty():
		return null
	var buf := StreamPeerBuffer.new()
	buf.big_endian = true
	buf.data_array = raw
	var type := buf.get_u8()
	if type != NbtWriter.TYPE_COMPOUND:
		return null
	var name := _read_name(buf)
	return {"name": name, "value": _read_compound_body(buf)}

static func _read_name(buf: StreamPeerBuffer) -> String:
	var n := buf.get_u16()
	var chunk: Array = buf.get_data(n)
	return (chunk[1] as PackedByteArray).get_string_from_utf8()

static func _read_compound_body(buf: StreamPeerBuffer) -> Dictionary:
	var out := {}
	while true:
		var type := buf.get_u8()
		if type == NbtWriter.TYPE_END:
			break
		var name := _read_name(buf)
		out[name] = _read_payload(buf, type)
	return out

static func _read_payload(buf: StreamPeerBuffer, type: int) -> Dictionary:
	match type:
		NbtWriter.TYPE_BYTE:
			return {"type": type, "value": buf.get_8()}
		NbtWriter.TYPE_SHORT:
			return {"type": type, "value": buf.get_16()}
		NbtWriter.TYPE_INT:
			return {"type": type, "value": buf.get_32()}
		NbtWriter.TYPE_LONG:
			return {"type": type, "value": buf.get_64()}
		NbtWriter.TYPE_FLOAT:
			return {"type": type, "value": buf.get_float()}
		NbtWriter.TYPE_DOUBLE:
			return {"type": type, "value": buf.get_double()}
		NbtWriter.TYPE_BYTE_ARRAY:
			var n := buf.get_32()
			var chunk: Array = buf.get_data(n)
			return {"type": type, "value": chunk[1]}
		NbtWriter.TYPE_STRING:
			return {"type": type, "value": _read_name(buf)}
		NbtWriter.TYPE_LIST:
			var item_type := buf.get_u8()
			var count := buf.get_32()
			var items: Array = []
			for i in count:
				if item_type == NbtWriter.TYPE_COMPOUND:
					items.append(_read_compound_body(buf))
				else:
					items.append(_read_payload(buf, item_type)["value"])
			return {"type": type, "item_type": item_type, "value": items}
		NbtWriter.TYPE_COMPOUND:
			return {"type": type, "value": _read_compound_body(buf)}
		NbtWriter.TYPE_INT_ARRAY:
			var n := buf.get_32()
			var arr := PackedInt32Array()
			arr.resize(n)
			for i in n:
				arr[i] = buf.get_32()
			return {"type": type, "value": arr}
		_:
			return {"type": type, "value": null}
