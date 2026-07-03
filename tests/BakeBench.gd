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
const _MAX := 500

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

	# Correctness: sync vs threaded at the current default batch must be byte-identical.
	var sync_res := await _run(blocks, false, 50)
	var sync_files := _snapshot_cache()
	var threaded_res := await _run(blocks, true, 50)
	var threaded_files := _snapshot_cache()
	_report("synchronous  batch=50", sync_res)
	_report("threaded     batch=50", threaded_res)
	_compare(sync_files, threaded_files)
	print("")

	# Responsiveness sweep: threaded at shrinking per-frame batch sizes. Lower batch =
	# lighter frames (smoother app) at some cost to total throughput.
	for b in [16, 8, 4, 2]:
		_report("threaded     batch=%d" % b, await _run(blocks, true, b))

	# Full frame distribution per batch, to pick a default that keeps frames light. The
	# warmup spike (first bake frame) is excluded so the numbers reflect steady state.
	print("")
	for b in [50, 16, 8, 4]:
		var res := await _run(blocks, true, b)
		_distribution("threaded batch=%-2d" % b, res["frames"])

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
	var t0 := Time.get_ticks_msec()
	await baker.prebake(blocks, Callable(), true)
	var dt := Time.get_ticks_msec() - t0
	_watching = false
	baker.free()
	var worst := 0.0
	for f in _frames:
		worst = maxf(worst, f)
	return {"total_ms": dt, "max_frame_ms": worst, "frames": _frames.duplicate()}

func _report(label: String, res: Dictionary) -> void:
	print("[bench] %-22s total %5d ms   worst frame %6.1f ms" % [
		label, int(res["total_ms"]), res["max_frame_ms"]])

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
