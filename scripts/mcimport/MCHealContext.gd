class_name MCHealContext
extends RefCounted

# What an MCImportExtension.heal() is handed: the freshly-imported library for one namespace,
# the source it came from, the namespace id, and the toolkit an extension needs to reshape the
# result — copy/composite textures, emit cube blocks, remove the presumptive ones, and reach
# mod files that sit NEXT to the source (a mod's lang). Centralizing the toolkit keeps every
# extension from re-implementing texture ingest / compositing / block emission, and keeps the
# generic importers (MCImporter, MCFlatImporter) free of any of this.
#
# Still a reader of the user's own assets (decision 4): compositing writes NEW pixels, but only
# ones synthesized from textures the user already owns — nothing is bundled.

# The namespace this heal targets. Named `ns`, not `namespace` — "namespace" is a reserved
# GDScript keyword and using it as a member/param name fails to parse (see BlockType.gd).
var library: BlockLibrary
var source: MCAssetSource
var ns: String
var warnings: Array[String] = []

# Decoded source images, keyed by texture ref (RGBA8, or null for a miss). A machine set reuses
# the same overlay across tiers and the same hull across every machine at a tier, so without this
# the same PNG is decoded thousands of times. Decoded once here instead.
var _img_cache := {}
# Outstanding worker-thread PNG-encode+write tasks (see _emit_texture); flush_composites() drains
# them. The encode is the bulk of a big heal's cost, and each composite is an independent file, so
# it parallelizes cleanly across cores.
var _write_tasks: Array[int] = []

func _init(lib: BlockLibrary, src: MCAssetSource, namespace_id: String) -> void:
	library = lib
	source = src
	ns = namespace_id

# ---------------------------------------------------------------------------
# Textures
# ---------------------------------------------------------------------------

# Copy a texture verbatim from the source into the library (deduped by ref), the same way the
# importers do. For a block whose look IS a single asset (a plain machine casing / hull).
func ensure_texture(ref: String) -> TextureAsset:
	return MCTexImport.ensure_texture(library, source, ref, warnings)

# Does the source actually carry this texture? Lets an extension probe for optional pieces
# (a tier's hull, an `_ACTIVE` overlay) before trying to use them.
func source_has_texture(ref: String) -> bool:
	return source.has_file(_ref_to_rel(ref))

# Synthesize a texture by drawing `overlay_ref` (a transparent icon) over `base_ref` (an
# opaque tile), stored under `out_id`. This is the crux of "healing" a mod that composites a
# block's look in Java from a hull + a transparent overlay: the assets hold the two layers
# separately, so we recreate the composite the renderer would. `base_ref` "" fills a neutral
# grey instead (no hull available). Deduped by out_id; returns null if the overlay can't load.
func composite_texture(out_id: String, base_ref: String, overlay_ref: String) -> TextureAsset:
	var existing := library.get_texture_asset(out_id)
	if existing != null:
		return existing
	var overlay := _load_ref_image(overlay_ref)
	if overlay == null:
		_warn("composite overlay missing: %s" % overlay_ref)
		return null
	var size := Vector2i(overlay.get_width(), overlay.get_height())
	var img := _tiled_base(base_ref, size)
	img.blend_rect(overlay, Rect2i(Vector2i.ZERO, size), Vector2i.ZERO)
	return _emit_texture(out_id, img, overlay_ref)

# An opaque base image at `size`: the `base_ref` tile repeated to fill it (a hull is 16×16 but
# an animated overlay is a taller frame strip), or a flat neutral grey when there's no base.
func _tiled_base(base_ref: String, size: Vector2i) -> Image:
	var out := Image.create(size.x, size.y, false, Image.FORMAT_RGBA8)
	var base := _load_ref_image(base_ref) if not base_ref.is_empty() else null
	if base == null:
		out.fill(Color(0.5, 0.5, 0.52))   # neutral casing grey
		return out
	var bw := base.get_width()
	var bh := base.get_height()
	var y := 0
	while y < size.y:
		var x := 0
		while x < size.x:
			out.blit_rect(base, Rect2i(0, 0, bw, bh), Vector2i(x, y))
			x += bw
		y += bh
	return out

# Persist a synthesized image as a library TextureAsset: write the PNG under the library's
# pixel folder, scan it for the planning color + transparency, and carry over `animated_from`'s
# frame animation (the composite is the same dimensions, so the frame layout matches).
func _emit_texture(out_id: String, img: Image, animated_from: String) -> TextureAsset:
	var sr := MCTexImport.split_ref(out_id)
	var rel := AssetLibrary.in_library(library.name,
		"%s/%s/%s.png" % [AssetLibrary.PIXELS_DIR, sr["ns"], sr["path"]])
	AssetLibrary.ensure_dir(rel.get_base_dir())
	var asset := TextureAsset.new()
	asset.id = out_id
	asset.image_path = rel
	# Scan (read-only) on the calling thread — the planning color feeds this asset synchronously.
	var scan := TextureIngest.scan_image(img)
	asset.average_color = scan["average"]
	asset.transparency = scan["transparency"]
	# Reuse the importers' .mcmeta parsing so a composited animated overlay still animates.
	MCTexImport._apply_mcmeta(asset, source, _ref_to_rel(animated_from) + ".mcmeta", img)
	library.add_texture_asset(asset)
	# Encode+write the PNG on a worker thread: img is freshly composited and touched nowhere else,
	# so save_png (read-only over its pixels) is safe off-thread. flush_composites() must run before
	# these files are read (the library save / preview prebake).
	_write_tasks.append(WorkerThreadPool.add_task(_save_png.bind(img, AssetLibrary.path_for(rel))))
	return asset

# Block until every dispatched composite PNG has been encoded + written. Called after the heal,
# before the library (and its previews) are persisted.
func flush_composites() -> void:
	for tid in _write_tasks:
		WorkerThreadPool.wait_for_task_completion(tid)
	_write_tasks.clear()

static func _save_png(img: Image, abs_path: String) -> void:
	img.save_png(abs_path)

# A decoded RGBA8 source image for a texture ref, decoded once and cached (null on a miss is
# cached too, so a repeatedly-referenced missing texture isn't re-read). Converting to RGBA8 here
# lets every composite blit/blend without re-converting a shared instance.
func _load_ref_image(ref: String) -> Image:
	if _img_cache.has(ref):
		return _img_cache[ref]
	var img := source.read_image(_ref_to_rel(ref))
	if img != null:
		img.convert(Image.FORMAT_RGBA8)
	_img_cache[ref] = img
	return img

# "ns:path" texture ref → its source-relative PNG path ("ns/textures/path.png").
static func _ref_to_rel(ref: String) -> String:
	var sr := MCTexImport.split_ref(ref)
	return "%s/textures/%s.png" % [sr["ns"], sr["path"]]

# ---------------------------------------------------------------------------
# Blocks
# ---------------------------------------------------------------------------

# Emit (or replace) a full-cube block bound to per-direction textures. `dir_to_texture` maps a
# BlockModel.Dir to a TextureAsset id (as returned by ensure_texture / composite_texture);
# `color` is the planning hint, `source_ns` the provenance, `tags` the searchable labels.
func add_cube(name: String, dir_to_texture: Dictionary, color: Color,
		tags: PackedStringArray, source_ns := "") -> BlockType:
	var faces := {}
	var textures := {}
	for d in dir_to_texture:
		var tid: String = dir_to_texture[d]
		faces[d] = BlockModel.make_face(tid)
		textures[tid] = tid
	var model := BlockModel.new()
	model.id = "%s:heal/%s" % [ns, name.validate_filename()]
	model.elements = [{"from": Vector3.ZERO, "to": Vector3.ONE, "faces": faces}]
	model.textures = textures
	if library.get_block_model(model.id) == null:
		library.add_block_model(model)
	else:
		library.remove_block_model(model.id)
		library.add_block_model(model)
	var bt := library.get_block_type(name)
	if bt == null:
		bt = library.add_block_type(name)
	bt.source_namespace = source_ns if not source_ns.is_empty() else ns
	bt.model_id = model.id
	bt.state_map = null
	bt.color = color
	bt.tags = tags
	return bt

# A block-type name not yet taken in this library, suffixing " 2", " 3", … on collision. Lets
# an extension use human display names (which can repeat across machines) as block names safely.
func unique_name(base: String) -> String:
	if library.get_block_type(base) == null:
		return base
	var i := 2
	while library.get_block_type("%s %d" % [base, i]) != null:
		i += 1
	return "%s %d" % [base, i]

func remove_block(name: String) -> void:
	library.remove_block_type(name)

# The texture ids a block's model binds — for an extension deciding which presumptive blocks a
# heal supersedes (e.g. "made only from basicmachines/ overlays → drop it").
func block_texture_ids(bt: BlockType) -> Array:
	var model := library.get_block_model(bt.model_id)
	return model.textures.keys() if model != null else []

# ---------------------------------------------------------------------------
# Sibling files (mod data that lives next to the source, not inside it)
# ---------------------------------------------------------------------------

# Text of a file sitting alongside the source on disk — searching the source's own directory
# and up to `max_up` parents. GregTech's per-machine display names live in an instance-level
# `GregTech.lang`, a sibling of the `mods/` folder the jar came from. "" if not found.
func read_sibling_text(filename: String, max_up := 3) -> String:
	var ap := source.archive_path()
	if ap.is_empty():
		return ""
	var dir := ap.get_base_dir()
	for _i in max_up + 1:
		var cand := dir.path_join(filename)
		if FileAccess.file_exists(cand):
			var f := FileAccess.open(cand, FileAccess.READ)
			if f != null:
				return f.get_as_text()
		var up := dir.get_base_dir()
		if up == dir:
			break
		dir = up
	return ""

func _warn(msg: String) -> void:
	warnings.append(msg)
