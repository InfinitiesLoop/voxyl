class_name MCZipSource
extends MCAssetSource

# An assets root that lives inside a `.zip` resource pack or `.jar` mod. Both store
# the tree under a top-level `assets/` folder, so a path the importer asks for
# ("minecraft/models/block/stone.json") maps to "assets/<rel>" inside the archive.
#
# Reads its own central directory once at open() (offset index below) instead of
# using Godot's ZIPReader.read_file(name): that call re-locates the entry by scanning
# the central directory from the start every single time, so its cost is proportional
# to the entry's position in the archive — O(n) per read. A real game jar carries tens
# of thousands of entries (mostly .class files) ahead of `assets/`, so importing ~1000
# blocks (thousands of individual reads, each deep in the archive) turned into minutes.
# Building our own name -> (offset, sizes, method) index once, then seeking straight to
# each entry's data, makes every read O(1) instead. Falls back to ZIPReader (the
# original, slower-but-always-correct path) for anything our lightweight parser doesn't
# recognize (zip64, spanned archives, corruption) — vanishingly rare for resource packs
# and mod jars, and the source stays open for the whole run either way.

const _BASE := "assets"

const _EOCD_SIG := 0x06054b50
const _CENTRAL_SIG := 0x02014b50
const _LOCAL_SIG := 0x04034b50
const _EOCD_MAX_TAIL := 65557   # 22-byte fixed record + up to a 64KiB comment

var _zip_path: String
var _ok := false
var _files := {}            # full in-zip path -> true (fast membership tests)

# Fast path: our own offset index, built once in _init(). Entry -> {offset, comp_size,
# uncomp_size, method}; `offset` points at the entry's local file header.
var _file: FileAccess
var _entries := {}

# Fallback path, only opened lazily if the fast parse fails on this archive.
var _fallback_reader: ZIPReader

func _init(zip_path: String) -> void:
	_zip_path = zip_path
	if _parse_index(zip_path):
		_ok = true
		return
	# Fast parser declined (unusual archive layout) — fall back to Godot's ZIPReader,
	# which is slower per-read but handles anything its zip implementation supports.
	_file = null
	_entries.clear()
	var reader := ZIPReader.new()
	if reader.open(zip_path) != OK:
		return
	_fallback_reader = reader
	_ok = true
	for f in reader.get_files():
		_files[f] = true

# --- Fast path: parse the central directory once, index every entry by name ------

func _parse_index(zip_path: String) -> bool:
	var f := FileAccess.open(zip_path, FileAccess.READ)
	if f == null:
		return false
	var length := f.get_length()
	if length < 22:
		return false
	var tail_size: int = mini(length, _EOCD_MAX_TAIL)
	f.seek(length - tail_size)
	var tail := f.get_buffer(tail_size)
	var eocd_pos := _find_eocd(tail)
	if eocd_pos < 0:
		return false

	var eocd := StreamPeerBuffer.new()
	eocd.big_endian = false
	eocd.data_array = tail.slice(eocd_pos)
	eocd.seek(10)   # skip signature(4) + disk#(2) + disk-with-CD(2) + entries-this-disk(2)
	var total_entries := eocd.get_u16()
	var cd_size := eocd.get_u32()
	var cd_offset := eocd.get_u32()
	if cd_offset + cd_size > length:
		return false   # zip64 (or garbage) — offsets don't fit a plain 32-bit record

	f.seek(cd_offset)
	var cd_bytes := f.get_buffer(cd_size)
	if cd_bytes.size() != cd_size:
		return false
	var cd := StreamPeerBuffer.new()
	cd.big_endian = false
	cd.data_array = cd_bytes

	for i in total_entries:
		if cd.get_available_bytes() < 46:
			return false
		if cd.get_u32() != _CENTRAL_SIG:
			return false
		cd.get_u16()          # version made by
		cd.get_u16()          # version needed
		cd.get_u16()          # general purpose flag
		var method := cd.get_u16()
		cd.get_u16()          # last mod time
		cd.get_u16()          # last mod date
		var crc32 := cd.get_u32()
		var comp_size := cd.get_u32()
		var uncomp_size := cd.get_u32()
		var name_len := cd.get_u16()
		var extra_len := cd.get_u16()
		var comment_len := cd.get_u16()
		cd.get_u16()          # disk number start
		cd.get_u16()          # internal file attributes
		cd.get_u32()          # external file attributes
		var local_offset := cd.get_u32()
		var name_bytes: PackedByteArray = cd.get_data(name_len)[1]
		var name := name_bytes.get_string_from_utf8()
		cd.get_data(extra_len + comment_len)
		if name.is_empty():
			continue
		_files[name] = true
		if not name.ends_with("/"):   # directory entries carry no data to read
			_entries[name] = {
				"offset": local_offset, "comp_size": comp_size,
				"uncomp_size": uncomp_size, "method": method, "crc32": crc32,
			}
	_file = f
	return true

# Scan backward for the EOCD signature (bytes 50 4B 05 06), searching from the end
# since an optional trailing comment can push it earlier than the last 22 bytes.
func _find_eocd(tail: PackedByteArray) -> int:
	var i := tail.size() - 22
	while i >= 0:
		if tail[i] == 0x50 and tail[i + 1] == 0x4B and tail[i + 2] == 0x05 and tail[i + 3] == 0x06:
			return i
		i -= 1
	return -1

# Read one entry's decompressed bytes via a direct seek to its local header (O(1) I/O,
# not a name scan). Local header's filename/extra lengths can in principle differ from
# the central directory's, so they're read fresh rather than assumed.
func _read_entry(name: String) -> PackedByteArray:
	var e = _entries.get(name)
	if e == null:
		return PackedByteArray()
	_file.seek(e["offset"])
	var header := _file.get_buffer(30)
	if header.size() < 30 or header[0] != 0x50 or header[1] != 0x4B \
			or header[2] != 0x03 or header[3] != 0x04:
		return PackedByteArray()
	var name_len: int = header[26] | (header[27] << 8)
	var extra_len: int = header[28] | (header[29] << 8)
	_file.seek(e["offset"] + 30 + name_len + extra_len)
	var comp := _file.get_buffer(e["comp_size"])
	match int(e["method"]):
		0:
			return comp
		8:
			return _inflate_raw_deflate(comp, e["uncomp_size"], e["crc32"])
		_:
			return PackedByteArray()   # unsupported method (bzip2/lzma/…) — vanishingly rare

# Zip's method-8 body is a bare raw-deflate stream (no container), but Godot's
# PackedByteArray.decompress() only accepts a full zlib or gzip container — and actually
# validates the trailing checksum before reporting success (a wrong or missing trailer
# fails decompression even though the deflate data itself decoded fine). zlib's trailer is
# an Adler32 of the OUTPUT, which we don't have until after decompressing — a chicken-and-
# egg problem. Gzip's trailer is a CRC-32 of the output instead, and the zip entry's own
# central directory record already carries exactly that CRC-32, so wrapping the raw stream
# in a minimal 10-byte gzip header + that CRC-32 + size trailer lets Godot's own GZIP mode
# do the inflate for us, no side channel needed.
func _inflate_raw_deflate(comp: PackedByteArray, uncomp_size: int, crc32: int) -> PackedByteArray:
	if uncomp_size == 0:
		return PackedByteArray()
	var gz := PackedByteArray([0x1F, 0x8B, 8, 0, 0, 0, 0, 0, 0, 0xFF])
	gz.append_array(comp)
	for shift in [0, 8, 16, 24]:
		gz.append((crc32 >> shift) & 0xFF)
	var isize: int = uncomp_size & 0xFFFFFFFF
	for shift in [0, 8, 16, 24]:
		gz.append((isize >> shift) & 0xFF)
	return gz.decompress(uncomp_size, FileAccess.COMPRESSION_GZIP)

# --- Public interface ---------------------------------------------------------

func _full(rel: String) -> String:
	return _BASE if rel.is_empty() else "%s/%s" % [_BASE, rel]

func list_namespaces() -> PackedStringArray:
	return _immediate(_BASE + "/", true)

func list_files(rel_dir: String) -> PackedStringArray:
	return _immediate(_full(rel_dir) + "/", false)

# Every file at or below rel_dir, each relative to it ("agon/0.png"). Zip entries are a
# flat path list, so this is just a prefix scan; directory entries (trailing "/") skipped.
func list_files_recursive(rel_dir: String) -> PackedStringArray:
	var prefix := _full(rel_dir) + "/"
	var out := PackedStringArray()
	for full in _files.keys():
		if not full.begins_with(prefix):
			continue
		var rest: String = full.substr(prefix.length())
		if not rest.is_empty() and not rest.ends_with("/"):
			out.append(rest)
	return out

# Immediate children (dirs or files) under a full in-zip prefix. Zip entries are a
# flat list, so a directory is inferred from any deeper path that shares the prefix.
func _immediate(prefix: String, want_dirs: bool) -> PackedStringArray:
	var seen := {}
	for full in _files.keys():
		if not full.begins_with(prefix):
			continue
		var rest: String = full.substr(prefix.length())
		var slash := rest.find("/")
		if want_dirs:
			if slash > 0:
				seen[rest.substr(0, slash)] = true
		elif slash < 0 and not rest.is_empty():
			seen[rest] = true
	var out := PackedStringArray()
	for k in seen:
		out.append(k)
	return out

func has_file(rel: String) -> bool:
	return _ok and _files.has(_full(rel))

func read_text(rel: String) -> String:
	if not has_file(rel):
		return ""
	return _read(_full(rel)).get_string_from_utf8()

func read_image(rel: String) -> Image:
	if not has_file(rel):
		return null
	var img := Image.new()
	return img if img.load_png_from_buffer(_read(_full(rel))) == OK else null

func read_bytes(rel: String) -> PackedByteArray:
	if not has_file(rel):
		return PackedByteArray()
	return _read(_full(rel))

func _read(full: String) -> PackedByteArray:
	if _file != null:
		return _read_entry(full)
	return _fallback_reader.read_file(full)

func close() -> void:
	if _file != null:
		_file.close()
		_file = null
	if _fallback_reader != null:
		_fallback_reader.close()
		_fallback_reader = null
	_ok = false

# Safety net for callers that forget close(). Inlined rather than calling close() —
# during PREDELETE the script instance is mid-teardown and dispatching a user method
# off it errors, so we release the handles directly.
func _notification(what: int) -> void:
	if what == NOTIFICATION_PREDELETE:
		if _file != null:
			_file.close()
			_file = null
		if _fallback_reader != null:
			_fallback_reader.close()
			_fallback_reader = null

func archive_path() -> String:
	return _zip_path

func describe() -> String:
	return _zip_path
