extends Node

# Throwaway perf/correctness harness for BlockIconBaker. Bakes the largest library's
# icons under several configs (threaded on/off, various per-frame batch sizes), and for
# each reports total wall time AND the worst single-frame time — the number that maps to
# in-app sluggishness (a big per-frame spike = a visible hitch). Also verifies the first
# two runs produced byte-identical PNGs (threaded == synchronous, purely a speed change).
#
# Run WINDOWED (headless renders blank through the dummy driver):
#   /c/godot.exe --path . res://tests/BakeBench.tscn
# Delete this + the .tscn when done — it's not part of the suite.

# A scratch dir, NOT the app's real user://icon_cache/, so benching doesn't wipe the
# user's warm cache (BlockIconBaker.cache_dir is redirected here per run).
const _CACHE_DIR := "user://bench_icon_cache/"
# Cap the sample so a giant library (e.g. gtnh's 21k blocks) still benches in seconds
# while staying representative — the threaded win scales with count, this just samples it.
const _MAX := 1200

# Frame-time watch (records every frame delta while a bake runs).
var _watching := false
var _frames: Array[float] = []

func _process(delta: float) -> void:
	if _watching:
		_frames.append(delta * 1000.0)

func _ready() -> void:
	# Let the autoloads settle (VoxelWorld loads persisted libraries in its own _ready).
	await get_tree().process_frame
	await get_tree().process_frame

	var lib := _largest_library()
	if lib == null:
		print("[bench] no library with blocks found; import something first.")
		get_tree().quit(1)
		return
	var blocks := lib.sorted_block_types()
	if blocks.size() > _MAX:
		blocks = blocks.slice(0, _MAX)
	print("[bench] library '%s' — baking %d blocks per config\n" % [lib.name, blocks.size()])

	# Correctness: sync vs threaded at the default atlas grid must be byte-identical.
	var sync_res := await _run(blocks, false, 64)
	var sync_files := _snapshot_cache()
	var threaded_res := await _run(blocks, true, 64)
	var threaded_files := _snapshot_cache()
	_report("synchronous  batch=64", sync_res)
	_report("threaded     batch=64", threaded_res)
	_compare(sync_files, threaded_files)
	# Phase split from the SYNCHRONOUS run (the threaded path hides the write on worker
	# threads, so its write_ms reads ~0). This is where the remaining wall time actually goes.
	_phases("synchronous  batch=64", sync_res)
	print("")

	# Throughput/responsiveness sweep across atlas grid sizes. With one readback per batch,
	# a bigger grid means fewer total GPU stalls (faster wall time) but a heavier single
	# frame; this finds where that trade-off sits now.
	for b in [64, 32, 16, 8]:
		_report("threaded     batch=%d" % b, await _run(blocks, true, b))

	# Full frame distribution per grid size, to pick a default that keeps frames light. The
	# warmup spike (first bake frame) is excluded so the numbers reflect steady state.
	print("")
	for b in [64, 32, 16, 8]:
		var res := await _run(blocks, true, b)
		_distribution("threaded batch=%-3d" % b, res["frames"])

	get_tree().quit(0)

# Clear the disk cache, then force-bake every block with the chosen threading mode and
# per-frame batch. Returns { total_ms, max_frame_ms }.
func _run(blocks: Array, use_threads: bool, batch: int) -> Dictionary:
	var baker := BlockIconBaker.new()
	baker.use_threads = use_threads
	baker.batch = batch
	baker.cache_dir = _CACHE_DIR   # before add_child: _ready creates the dir + viewport pool
	add_child(baker)
	_clear_cache()
	_frames = []
	_watching = true
	# Snapshot the shared decode/upload counters so we can report THIS run's delta — only the
	# first (cold) run misses the texture cache; later runs hit it and add ~0.
	var dec0 := BlockTextureCache.prof_decode_us
	var up0 := BlockTextureCache.prof_upload_us
	var t0 := Time.get_ticks_msec()
	await baker.prebake(blocks, Callable(), true)
	var dt := Time.get_ticks_msec() - t0
	_watching = false
	var res := {
		"total_ms": dt, "frames": _frames.duplicate(),
		"build_ms": baker.prof_build_us / 1000.0, "read_ms": baker.prof_read_us / 1000.0,
		"write_ms": baker.prof_write_us / 1000.0, "reconcile_ms": baker.prof_reconcile_us / 1000.0,
		"predecode_ms": baker.prof_predecode_us / 1000.0,
		"decode_ms": (BlockTextureCache.prof_decode_us - dec0) / 1000.0,
		"upload_ms": (BlockTextureCache.prof_upload_us - up0) / 1000.0,
	}
	baker.free()
	var worst := 0.0
	for f in _frames:
		worst = maxf(worst, f)
	res["max_frame_ms"] = worst
	return res

func _report(label: String, res: Dictionary) -> void:
	print("[bench] %-22s total %5d ms   worst frame %6.1f ms" % [
		label, int(res["total_ms"]), res["max_frame_ms"]])

# Where the wall time goes: main-thread build + readback/slice + disk write + the end-of-run
# stale sweep. Summed across the whole run (not per frame), so build+read+write+reconcile
# should roughly account for total on the synchronous path.
func _phases(label: String, res: Dictionary) -> void:
	print("[bench] %-22s build %6.1f  read %6.1f  write %7.1f  reconcile %6.1f  (ms)" % [
		label, res["build_ms"], res["read_ms"], res["write_ms"], res["reconcile_ms"]])
	# Texture half of build (cold cache): decode = PNG→Image work (now summed across worker
	# threads, so it can exceed wall time), upload = create GPU texture (main-thread only),
	# predecode = the main-thread WALL spent waiting on the parallel decode. The win shows as
	# predecode ≪ decode (work parallelized) and build_ms dropping toward predecode + upload.
	print("[bench] %-22s   textures: decode(work) %7.1f  predecode(wall) %6.1f  upload %5.1f  (ms)" % [
		label, res["decode_ms"], res["predecode_ms"], res["upload_ms"]])

# Print count / avg / median / p95 / max plus how many frames exceeded 33ms (jank),
# excluding the one-time warmup spike (worst frame) so numbers reflect steady state.
func _distribution(label: String, frames: Array) -> void:
	if frames.size() < 3:
		print("[bench] %s: too few frames" % label)
		return
	var sorted := frames.duplicate()
	sorted.sort()
	sorted.remove_at(sorted.size() - 1)   # drop the warmup spike
	var sum := 0.0
	var janky := 0
	for f in sorted:
		sum += f
		if f > 33.0:
			janky += 1
	var n := sorted.size()
	var idx95: int = int(n * 0.95)
	print("[bench] %s: frames=%d avg=%.1f median=%.1f p95=%.1f max(steady)=%.1f  >33ms=%d" % [
		label, n, sum / n, sorted[n / 2], sorted[idx95], sorted[n - 1], janky])

# The library with the most block types (the meaty one to bench); null if none has any.
func _largest_library() -> BlockLibrary:
	var best: BlockLibrary = null
	for lib in VoxelWorld.workspace.libraries:
		if best == null or lib.block_types.size() > best.block_types.size():
			best = lib
	if best != null and best.block_types.is_empty():
		return null
	return best

# filename -> PNG bytes for every icon currently on disk.
func _snapshot_cache() -> Dictionary:
	var out := {}
	var dir := DirAccess.open(_CACHE_DIR)
	if dir != null:
		for f in dir.get_files():
			if f.ends_with(".png"):
				out[f] = FileAccess.get_file_as_bytes(_CACHE_DIR + f)
	return out

func _clear_cache() -> void:
	var dir := DirAccess.open(_CACHE_DIR)
	if dir == null:
		return
	for f in dir.get_files():
		dir.remove(f)

# Verify the two runs wrote the same files with identical bytes.
func _compare(a: Dictionary, b: Dictionary) -> void:
	var mismatches := 0
	for f in a:
		if not b.has(f) or a[f] != b[f]:
			mismatches += 1
	if mismatches == 0 and a.size() == b.size():
		print("[bench] OK: %d icons byte-identical across both paths" % a.size())
	else:
		print("[bench] MISMATCH: %d differing / sync %d vs threaded %d files" % [
			mismatches, a.size(), b.size()])
