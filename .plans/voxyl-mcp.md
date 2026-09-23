# Voxyl MCP — Agent Tooling Plan

Status: **P1 accepted** (2026-09-22) — the acceptance run (§7) passed in a real Claude session. Next up: P2.

Built so far (branch `shaped-parts`):
- Server, Settings dialog (Home + editor bar ⚙), Pause button + presence badge, `--sandbox` /
  `--mcp-port` / `--mcp-token` command-line flags for scripted runs.
- Core: `VoxelWorld.apply_edits` (validated batches, rejection reasons), `SpatialXform`
  (symmetry, repeat, part-slot transforms incl. LH/RH twins), `RegionOps`, `RegionCodec`,
  slot names + orientation words, scratch projects, per-palette saves.
- CaptureService stage 1 (private offscreen View3D + 2D compositing stage), `CameraFraming`,
  `ViewOptions` registry + per-view toolbar with Render (Textured / Intent / Clay), Lighting
  (App / Studio / Flat), Projection (Perspective / Orthographic) and Camera presets.
- Tools: everything marked P1 in §6, plus `screenshot`, `palette_delete`, `project_delete`,
  capture_sheet presets `elevations` / `turntable`. Not yet: `capture_pick`, `checkpoint`,
  named regions, `region_transform` / `region_stamp`, SSE, workspace lock file.
- Fixed on the way: every View3D now has its own 3D world (they used to share the root world,
  so split panes each rendered every pane's meshes).
- Verified: `tests/McpTest.gd` (real HTTP, headless, sandboxed) plus a sandboxed windowed run
  driven over HTTP (captures, review/elevation sheets, intent mode, swatches, palette render,
  view toolbar, `view_set`, `screenshot`). Claude Code (desktop app) connects and lists the
  tools.

Connecting (learned the hard way, 2026-09-22):
- Register at **user scope**: `claude mcp add --scope user --transport http voxyl
  http://127.0.0.1:47823/mcp --header "Authorization: Bearer <token>"` (Settings → Copy setup
  command produces exactly this). The default "local" scope ties the server to whichever
  folder the command ran in.
- Plain `http://127.0.0.1` is fine. The desktop app's Connectors "Add" form insists on HTTPS,
  but that's only for remote connectors; `~/.claude.json` servers load into Code-tab sessions.
- A session loads its MCP servers when it starts; `/mcp` → reconnect can't add one to a running
  session. In the desktop app `/mcp` opens the Connectors screen, which doesn't list
  `~/.claude.json` servers — ask the session about its voxyl tools instead.
- Start Voxyl (with agent connections on) before the session.

**Acceptance run result (2026-09-22):** rebuilt the pillar as "Conduit Pillar Replay" — read the
original's palette + full text-codec dump first (read-only, `palette_get`/`region_stats`/
`region_text`), then rebuilt it from a fresh scratch project through `block_search`,
`block_swatches`, `palette_create`, `project_create`, `region_fill`, `cells_place_layers`
(symmetry `rotate4` + `repeat` for the shaft courses), `parts_add` (verified `rotate4` remaps
microblock slots correctly — SE corner → SW/NE/NW as expected), `capture_sheet`/`capture`
(textured review sheet + intent mode), a colonnade check (`region_copy` + `clipboard_paste` with
`repeat`, then `history undo` to drop it before saving), and `project_save`. Diffed the rebuild
against the original's `region_text` dump programmatically (byte-exact match, 690 cells) and
confirmed `region_stats` counts matched exactly. Also confirmed rejection reasons work
(`shaped_semantic_needs_part`, `slot_taken`) via `dry_run` probes.
~34 tool calls total, in range. Two mistakes surfaced, both mine (hand-transcribing the text
dump), not tool bugs — the codec's round-trip via `region_text` is what caught them:
- Filled the y=0 plinth base as 5×5 instead of the original's 7×7 (`region_fill` region size
  error). Fixed with a corrective `region_fill`.
- One off-by-one character in the crown's z=-8 row when copying it by hand. Fixed with
  `cells_clear` + `cells_set`.
No server-side bugs, no rejected placements in the real build, no leaked files, nothing written
outside Voxyl's own saves. `logs` showed a clean `ok` trail for every call.

**Next:** P2 — SSE, render modes (clay/outline/xray/wire) + full toolbar, ortho/elevations,
studio lighting, section/isolate, transforms, array/stamp, symmetry editing mode for users, named
regions, checkpoints, BOM, `capture_pick`, presence basics, sub-cell text resolution, remaining
CRUD (see §7).

Origin: the "Conduit Pillar" experiment. Claude designed a 5x5 sci-fi pillar inside Voxyl, looking
at renders as it went. It worked well (the result is the `Conduit Pillar` project + palette), but
every step went through hand-written Godot scripts and private fields. This plan turns each of
those workarounds into a real tool, plus new Voxyl features that would have made the design better.

Goal in one line: **an agent can do everything a user can do in Voxyl, and also has design
instruments the UI doesn't have yet, all through MCP calls, while the user watches every change
live in their own window.**

Decisions from the user (2026-09-22):
- **Pure GDScript, nothing to install.** Voxyl itself is the MCP server. There's no Node/Python
  proxy.
- **Attach by default.** Claude works in the user's running Voxyl. Every surface updates live
  (views, palettes, libraries, templates, home screen) with no manual refresh or reload.
- **Ships in release builds, off by default.** Settings control the port, with a sensible
  default.
- **Render modes are chosen from a per-view toolbar of dropdowns, not keybindings.** Each 3D view
  keeps its own settings.

---

## 1. What the experiment had to fake

| # | Workaround in the pillar session | Cost | What replaces it |
|---|---|---|---|
| 1 | Wrote a `-s` SceneTree driver that boots `Main.tscn`. The `VoxelWorld` autoload doesn't compile in `-s` scripts, so it was looked up at runtime with untyped vars | ~6 failed launches before first render | In-app MCP server (§3) |
| 2 | Finding the 3D view meant a duck-typed tree walk. The driver poked `_viewport`, `_camera`, `_highlight`, `_save_timer` | Brittle; breaks on refactor | `capture` / `view_set` tools; a CaptureService with its own camera |
| 3 | A second Voxyl process ran beside the user's. Its autosave and "save every palette" could collide with theirs, and a crashed run leaked a `Pillar Probe` project into `projects/` | Risk to user data; manual cleanup | One process: the user's own (attach). Scratch projects, dirty-only saves |
| 4 | Picking materials: composited raw texture PNGs into contact sheets, then built a "material wall" to see them lit. Mapped images to names by counting columns | 3 renders + guesswork | `block_search` + labeled `block_swatches` rendered under app lighting |
| 5 | ArchitectureCraft orientation: brute-forced slots by matching triangle normals (`arch_slot`) | Custom geometry code | `shape_describe` + `shape_orient` with direction words |
| 6 | Hand-rolled `sym4`, diagonal mirror, and `origin` offsets to lay out variants | Custom code, easy to get wrong | `symmetry` + `repeat` on every edit tool; `region_stamp`; variant sheets |
| 7 | Camera: derived yaw/pitch from target math, overrode a private FOV, composited 2x2 sheets itself | Custom compositor, unlabeled tiles | `capture` with a CameraSpec (frame a region, from a compass side, fit), `capture_sheet` with captions |
| 8 | Only textured, shaded renders. Faces pointing down render near black, and a 1-wide channel hid its light at most angles, so structure was hard to read | Several design rounds spent diagnosing visibility | Intent / wire / x-ray / outline / section render modes, studio lighting, text layer dumps |
| 9 | `add_part` returned only `false`. The rung-vs-slab conflict had to be inferred | Guessing | Rejection reasons from ShapeRules |
| 10 | The whole build was one undo op via private calls. No checkpoints, so variants lived side by side in one probe project | Clutter | Per-call undo steps, named checkpoints, scratch projects |

---

## 2. Goals, non-goals, guardrails

**Goals**
- Full parity with the UI: libraries, palettes, projects, templates, every edit tool,
  selection/clipboard, history, views.
- Design instruments: cameras that frame what you ask for, render modes that reveal structure,
  text dumps the model can read cheaply, labeled images, and diagnostics for why an edit failed.
- Live co-building. The user sees each change as it happens, everywhere in the UI.
- Zero install. Voxyl plus an MCP client is the whole setup.
- The pillar session, replayed start to finish through MCP calls alone (acceptance test, §7).

**Non-goals**
- Minecraft export/import in core. Those stay in an extension group (see the guardrails below).
- Replacing the UI. Every new capability should also be reachable by a human where it makes sense.
- Supporting MCP clients that only speak stdio. They would need a third-party HTTP bridge (see
  §9).

**Guardrails (CLAUDE.md principles, applied)**
- **The MCP server is a client, like a view.** Every mutation goes through `VoxelWorld` (signals,
  undo, ShapeRules). No direct `VoxelData` / `Palette` writes from tool handlers. This is also
  what makes live updates work (§3.4).
- **Tools speak semantics.** Placement tools take semantic names only. Materials change only
  through palette tools. Placing a semantic that no palette maps yet is allowed and renders as
  undecided (Principle 5).
- **Renders are lenses.** Capture settings never write voxel data. A 3D view's render settings
  are view state, like its camera: saved with the layout, never in voxel data or palettes.
- **Neutral vocabulary.** Tool names and descriptions say "block", "shape", "slot", never mod
  names. Minecraft-specific tools (`mc_import_*`, a future `mc_export_*`) register only when the
  `mcimport` extension is present, like `mcimport/` itself.
- **Features land in their layer.** Region ops, transforms, symmetry and the text codec go in
  core (`VoxelWorld` / data helpers), so the 2D and 3D views get them too. Render modes go in the
  3D view, usable by humans. The MCP layer only translates.

---

## 3. Architecture: Voxyl is the MCP server

```
Claude Code ──MCP Streamable HTTP──▶ http://127.0.0.1:47823/mcp   (Authorization: Bearer …)
                                          │
┌─────────────────────── Voxyl, the user's running app ────────────────────────┐
│ McpServer (autoload, off by default)                   scripts/automation/   │
│   HttpListener    TCPServer, HTTP/1.1 keep-alive, polled in _process         │
│   McpProtocol     initialize · tools/* · resources/* · prompts/* · ping      │
│   ToolRegistry    tools/*.gd  (name, description, JSON Schema, handler)      │
│        │ edits / queries                       │ renders                     │
│        ▼                                       ▼                             │
│   VoxelWorld (single source of truth) ◀── CaptureService (offscreen camera)  │
│        │ signals                                                             │
│        ▼                                                                     │
│   Every UI surface refreshes live: 3D/2D views, view toolbars, hotbar,       │
│   inventory, palette editor, library list, home screen + thumbnails,         │
│   templates, history buttons                                                 │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Is pure GDScript doable? Yes.
MCP's **Streamable HTTP** transport is JSON-RPC 2.0 over HTTP POST to one endpoint. The spec lets
a server:
- answer a POST with a plain `application/json` body (no SSE stream)
- return `202 Accepted` for notifications
- return `405` for `GET` when it doesn't offer server-initiated streams

So the minimum is a TCP listener, a small HTTP/1.1 parser and a JSON-RPC dispatcher. All three
are ordinary GDScript (`TCPServer`, `StreamPeerTCP`, `JSON`, `Marshalls.raw_to_base64`).

- **Connect**: `claude mcp add --transport http voxyl http://127.0.0.1:47823/mcp --header "Authorization: Bearer <token>"`.
  Settings has a **Copy setup command** button that fills this in (§3.2).
- **Spec target**: the newest revision Claude Code supports at build time (2025-06-18 or later).
  Verify every item below against that revision.
  - Issue `Mcp-Session-Id` at `initialize` and honor the `MCP-Protocol-Version` header.
  - Implement `ping`.
  - Advertise only the capabilities actually implemented.
- **HTTP details**:
  - Bind `127.0.0.1` only.
  - Non-blocking accept and read, polled from `_process`.
  - Request bodies by `Content-Length` only (answer chunked uploads with `411`/`501`).
  - Keep-alive with several requests per connection.
  - Per-request read timeout; body size cap.
- **Writing big responses**: image payloads are MB-sized base64, so write with `put_partial_data`
  in a loop that spans frames. Never block a frame.
- **Handlers** run on the main thread (safe to touch the scene and `VoxelWorld`) and may `await`
  (captures, imports) while the HTTP connection waits. Answer oversized batches with a
  `too_large` error that suggests splitting.
- **P2: SSE streams** add `notifications/progress` for long jobs (imports, turntables) and
  `notifications/resources/updated`. P1 doesn't need them.

Trade-offs of having no proxy, all acceptable with attach as the default:
- The server exists only while Voxyl runs with agent connections enabled. If Claude Code starts
  first, it shows the server as disconnected. Start Voxyl, then reconnect (`/mcp` → reconnect).
  Check how Claude Code auto-reconnects HTTP servers and document it in the Settings help text.
- There's no way for Claude to launch Voxyl through MCP. It can still run the binary itself if
  asked.

### 3.2 Settings: ships, off by default
Voxyl has no settings system yet. Add:
- **`AppSettings`**: app config in `user://settings.cfg` via `ConfigFile`. This is not project
  data and not the material layer.
- **A Settings dialog**, reachable from the Home screen and the editor bar.

**Agent connections** section:
- **Allow agent connections**: toggle, **off** by default.
- **Port**: default **47823**. Applying a change restarts the listener immediately.
- **Require access token**: on by default. Shows the token with a **Regenerate** button.
- **Copy setup command**: the full `claude mcp add …` line, with the port and token filled in.
- **Status line**: e.g. "Listening on 127.0.0.1:47823 · 1 client · last call 3s ago", or
  "Port 47823 is in use — choose another".
- If the bind fails, the status line says so. The listener never silently falls back to another
  port, because the client's URL is fixed.

Why 47823:
- It's below the OS dynamic range (49152–65535), where Windows Hyper-V/WSL reserve random
  blocks. This machine reserves 50000–50059, 53289–53802 and 58537–58636.
- It avoids common dev servers (3000, 5000, 5173, 8000, 8080, 8888) and Godot's own ports
  (6005–6007).
- Nothing listens in the 47xxx range here.

### 3.3 Tool registry
- Each tool is a small GDScript file in `scripts/automation/tools/`: name, description, JSON
  Schema for params and result, and a handler. Shared types (§4) are defined once and referenced.
- `tools/list` is generated straight from the registry, so there's no export step and no
  contract drift.
- The MC import group registers itself from `mcimport/`, so core never names the mod.
- Each **mutating call is one undo step**, named `"Claude: <tool>"`, via
  `begin_operation`/`end_operation`. Batch tools are one step too. The history list shows
  Claude's steps and the user's side by side, and Ctrl+Z works on them like any other step.
- **Placement FX**: agent edits play the same reveal ripple as the user's by default
  (`animate: false` to skip), so you can watch a build come together.

### 3.4 Live updates: the attach contract
Because the server runs inside the user's process, Claude's edits are the same in-memory changes
a user's clicks make. They show up live as long as the UI reacts to **signals**, not to its own
actions. Requirements:

1. **Handlers call the same `VoxelWorld` methods the UI calls.** Where a UI flow does work
   outside `VoxelWorld` today (a dialog mutating a palette entry, then refreshing only itself),
   move that work into `VoxelWorld` first so both paths share it.
2. **Every surface refreshes from signals.** Audit each one; ✓ = already signal-driven,
   verify = check in code, new = needs a new signal.

   | Surface | Refreshes on | Status |
   |---|---|---|
   | 3D views, 2D slice views | `block_changed`, `palette_stack_changed`, `block_type_changed`, `project_opened` | ✓ |
   | Hotbar | `hotbar_changed`, `active_slot_changed` | ✓ |
   | History buttons | `history_changed` | ✓ |
   | Inventory grid, Home palette editor, `PalettePanel`, `LibraryList` | `workspace_changed` | verify; several may refresh only after their own dialogs |
   | Home project list + thumbnails | `projects_changed` (created / renamed / deleted), `thumbnail_changed` | new |
   | Templates list | `templates_changed` | new |
   | View toolbars (§5-U) | a per-view `settings_changed` | new |
   | Region selection overlay, named regions | `region_selection_changed`, `regions_changed` | ✓ / new |
   | Open dialogs (entry editor, rename, import) | close or refresh if their target is removed or renamed underneath them | verify |

3. **Mid-action safety.** If the user is mid-operation (a paint drag, `_op_depth > 0`) or has a
   modal open on the same object, the server queues Claude's call until that finishes, so the
   two never interleave into one undo step.
4. **Project guard.** Edit tools act on the project open in the editor and accept `project`
   (the expected name). If the user has switched projects, the call fails with
   `project_changed`. From the Home screen, `project_open` opens the project in the user's editor
   so they see it.
5. **Saving is unchanged.** Autosave and palette saves behave exactly as they do for user edits.
   Also make palette/library saves dirty-only, instead of rewriting every palette.
6. **Tests.**
   - Signal-coverage test: each mutating tool fires the signals listed above.
   - UI refresh smoke test (extends `ShellTest`): create a palette, template and project through
     the registry, then assert the inventory, palette editor, Home list and templates list show
     them on the next frame, with no reload.

### 3.5 Other safety
- **Second instance.** A workspace lock file (`library/.voxyl.lock` with a pid) makes a second
  Voxyl on the same workspace warn and open read-only. This is what bit the experiment.
- **Scratch projects** (`project_create {scratch: true}`) live in memory only and are never
  written until `project_save {as}`. The default for experiments.
- **Network exposure.** Bind to localhost only. Reject requests whose `Origin` header isn't
  local (DNS-rebinding protection the MCP spec asks for), and require the bearer token by
  default.
- **Destructive tools** (delete project, palette, library or template) require `confirm: true`.
- **Pause.** A **Pause Claude** button in the editor bar makes mutating calls fail with
  `paused_by_user` until the user resumes.

### 3.6 Results and images
- Every result includes `ok`, `data` and `warnings`. Edits also return `placed`, `cleared`,
  `rejected: [{pos, part?, reason, detail}]` and `undo_step`.
- **Every image is labeled.** The model can't hover, so labels are the hover. Each image gets:
  - a caption strip (view name, camera, mode, region size)
  - a compass/axes gizmo
  - optional coordinate ticks along the framed box
  - a legend in intent mode
  - tile captions in sheets
- Images return as MCP image content, PNG or JPEG via `format`. Default size is 1280x720, and
  sheets go up to about 1600 px wide. Each one is also saved to `user://captures/`, with the path
  in the text result so the user can open it.
- Each capture returns a `capture_id` that remembers its camera, for `capture_pick` (§5-T).
- **Resources.** `voxyl://conventions` (axes, slot names, text format, examples) and
  `voxyl://project/{name}/summary`. Tool descriptions point to the conventions resource instead
  of repeating it.
- **Prompts.** `design-review` (review sheet, then critique against the principles and the
  brief) and `material-study`.

---

## 4. Shared parameter types

Defined once in the registry and explained in `voxyl://conventions`.

- **Axes.** +Y is up, north = −Z, south = +Z, west = −X, east = +X (the same as `ShapeCatalog`).
  Positions are integer cells.
- **Direction words.** `up down north south east west`, aliases `+y -y -z +z +x -x`, plus the
  compass corners `ne nw se sw` for cameras.
- **Region.** One of:
  - `{min:[x,y,z], max:[x,y,z]}` (inclusive)
  - `{selection:true}`
  - `{named:"pillar-1"}`
  - `{semantic:"Mass"}` (bounding box of where that semantic is used)
  - `{all:true}`
  - optionally `{…, pad:n}`
- **Part slot names**, so nobody needs FMP numbering by heart. Numbers are still accepted.
  - face / hollow: a direction word (`north` = the face against −Z)
  - edge: the two sides it sits between, e.g. `south-east` (vertical), `down-north` (runs along
    X), `up-west` (runs along Z)
  - centered posts: `center-x`, `center-y`, `center-z`
  - corner: three sides, e.g. `down-north-west`
- **Orient** (architecture shapes): `{up:"+y", facing:"south"}`, or `{normals:[[1,0,1]]}`
  (faces the placed shape must have). `shape_describe` says what "facing" means for each shape
  (e.g. "roof tile: facing = the direction the slope looks toward").
- **PartSpec.** `{semantic, slot | orient}`. The shape comes from the semantic's palette entry,
  exactly as in the UI.
- **Symmetry.** Any of `{rotate4:{center:[x,z]}}`, `{mirror_x:x0}`, `{mirror_z:z0}`,
  `{mirror_diag:true}`. Parts are remapped through `rotate_slot_y` and a new mirror remap (§5-H).
- **Repeat.** `{count:n | [nx,ny,nz], step:[dx,dy,dz]}`, like an array modifier.
- **CameraSpec.**
  - Aim: `{frame: Region | point, from: "se" | yaw_deg, elevation: deg | "eye" | "low" | "high" | "top"}`
  - Distance: `distance` or `fit_margin` (auto-fit to the framed box)
  - Projection: `fov` (default 50; 75 matches the app), or `ortho: true` with auto scale
  - Other: `size: [w, h]`
  - Or give an explicit `{pos:[…], look_at:[…]}`.
  - `"eye"` puts the camera at standing height, 1.62 above the lowest used cell.
- **RenderSpec.** The same option set the view toolbar shows (§5-U), so a capture and a view
  can't disagree:
  - `mode`: `textured` · `intent` · `clay` · `outline` · `xray` · `wire` · `neon`
  - `lighting`: `app` · `studio` · `flat`
  - `background`: `app` · `plain` · `transparent`
  - `overlays`: any of `axes`, `bbox`, `ticks`, `grid`, `selection`, `legend`
  - `section`: `{axis, at, keep: "below" | "above" | "slab", thickness}`
  - `isolate` / `dim`: lists of semantics
- **ViewRef.** `"focused"` (default), or a view id from `view_list`. Every 3D view has its own
  camera and render settings.

---

## 5. New Voxyl features

Each entry covers what it is, why it helps the agent and the user, where it lives, and its phase.

**A. MCP server, Settings, tool registry** (P1). See §3.

**B. CaptureService** (stage 1 in P1, stage 2 in P3). This is offscreen rendering that never
touches the user's panes or camera.
- **Stage 1**: the service owns a private `View3D` inside an offscreen `SubViewport`. `View3D`
  already builds its own environment, lights, sky, grid, camera and voxel meshes inside its own
  viewport, and follows `VoxelWorld` signals, so it stays in sync for free. It needs a small
  public API: `set_camera(spec)`, `set_render(spec)`, `capture() -> Image`, `set_overlays`.
- **Stage 2**: pull the renderer core (meshing, material caches, environment rig) out of
  `View3D` (~3.4k lines) into a `VoxelSceneRenderer` that both `View3D` and captures share. That
  allows rendering a non-active or scratch project, and several regions side by side.

**U. View toolbar** (P1 skeleton, grows in P2). The way users pick render modes. No keybindings
needed.
- A slim toolbar inside **each** 3D view (top-left, over the viewport), with one dropdown per
  option:
  - **Render**: Textured / Intent / Clay / Outline / X-ray / Wire / Neon
  - **Lighting**: App / Studio / Flat
  - **Projection**: Perspective / Orthographic
  - **Camera**: Frame all / Frame selection / Front / Back / Left / Right / Top / Iso
  - **Section**: Off / Below Y / Above Y / Slab, with a Y spin box when on
- **One registry drives it all.** A `ViewOptions` registry holds each option's id, label,
  choices and apply callable. The toolbar builds its dropdowns from it, `RenderSpec` validates
  against it, and the CaptureService applies it. Adding a mode means one registry entry, and it
  appears in the dropdown, in captures and in the MCP schema.
- **Per view.** Each 3D view has its own settings, so a Textured view can sit beside a Wire view
  of the same build. Settings live in the view's state (`get_view_state` / `apply_view_state`)
  and persist with the project layout, like the camera.
- **Live.** When Claude changes a view through `view_set`, that view's dropdowns update through
  its `settings_changed` signal.
- P1 ships the toolbar with Render: Textured, Lighting: App, Projection: Perspective and the
  Camera frame buttons. P2 fills in the rest.

**C. Camera framing + orthographic** (framing P1, ortho P2).
- `frame(region, from, elevation, fit)` for any 3D view, and a "frame selection" hotkey for users.
- An orthographic toggle, plus elevation presets (front, side, top, iso). Ortho elevations are
  what designers actually use to judge proportion and depth steps. In the pillar session, depth
  had to be inferred from perspective shots.
- Exposed through the toolbar's Projection and Camera dropdowns.

**D. Render modes** (P2; neon in P3). These are the Render dropdown's entries.
- `intent`: every semantic in its own flat, distinct color (golden-ratio hues), plus a legend.
  Structure, independent of materials. This is Principle 1 made visible, and it's the best mode
  for a model to read.
- `clay`: one neutral material with soft lighting, to judge form and shadow only.
- `outline`: hidden-line drawing, meaning flat fills with dark feature edges.
- `xray`: faces at about 15% opacity plus all edges, so you can see inside the pillar's core and
  the channel depth.
- `wire`: feature edges only, drawn through everything, colored by semantic. The whole structure
  at once.
- `neon` (P3): `wire` with thick emissive lines and bloom over the synthwave grid. A Tron render
  of the build.

Implementation notes:
- **Edge extraction.** Build from the same geometry the mesher uses: `BlockModel` boxes and AC
  triangle meshes. For boxes, keep only *feature* edges. An edge shared by two coplanar visible
  faces (neighboring solid cells, a strip lying on a cover) is interior and gets dropped. For AC
  meshes, keep boundary edges plus creases above about 20°.
- **Line drawing.** Batch lines per chunk into `PRIMITIVE_LINES` ArrayMeshes, unshaded. `wire` and
  `xray` use no depth test. Godot lines are 1px, so `neon` and a thick `outline` need
  screen-space quads.
- **Cheaper `outline`.** A depth+normal edge-detection `CompositorEffect` (Godot 4.3+).
- **Principle check**: these are pure lens features and never touch data.

**E. Lighting presets and emissive blocks** (presets P2, emissive P3).
- `studio` preset: hemisphere ambient plus fill lights, so downward faces are readable. In the
  pillar session, beam undersides and slopes rendered almost black. `flat` preset: no shading.
- The app default stays as it is unless the user decides otherwise.
- **Emissive blocks**: a material-layer property on `BlockType` (`light_emission`). The MC import
  would map it from light level, and it could also be toggled by hand. `View3D` renders it
  emissive with optional glow. The pillar's cyan channels would actually glow. Principle check:
  emission is a property of the material layer, not of voxel data, so this is fine.

**F. Section, cutaway and isolate** (P2).
- A clip plane or Y-range in 3D (shader clip, or per-cell culling for whole cells).
- Isolate or dim selected semantics.
- Useful for users building interiors, and for checking hidden structure (the pillar's core).
- Exposed as the toolbar's Section dropdown.

**G. Region text codec** (1-cell resolution P1, finer resolutions P2). This is the cheapest way
for a model to see and author structure. It works in both directions.
- **Format.** `layers` is ordered by +Y from `origin.y`. Each layer is a list of rows by +Z
  (north→south), and each row is a string by +X (west→east).
- **Legend.**
  - A character maps to a semantic (a whole block) or to a list of PartSpecs (a part cell).
  - `.` = leave untouched, `_` = clear.
- **Output.** `region_text` writes the same format with an auto-generated legend, so dumps and
  edits round-trip.
- **Resolution.** `resolution: 2 | 8` draws each cell as a 2×2 or 8×8 character block showing
  sub-cell occupancy, for checking slabs, rods and notches. Also works along X or Z, giving text
  elevations.

**H. Region ops in core** (fill/replace/move P1; transforms/array P2).
- Fill styles: `solid`, `hollow`, `walls`, `frame` (edges only), `floor`.
- Also: replace (the exchange tool), move, rotate Y by 90° steps, mirror X/Z, array/stamp.
- **Mirroring parts.** Microblocks remap by bounds, as `mirror_diag_slot` did in the driver.
  Architecture shapes are chiral: remap through LH/RH pairs (`cornice_lh`/`_rh`,
  `roof_overhang_gable_lh`/`_rh`, …) or reject with a reason.
- These make the paste-rotation code a special case of one transform function.

**I. Symmetry editing mode** (P2). A user tool option (mirror X, mirror Z, radial 4 around a
pivot) that lives in `VoxelWorld`, so the 2D view, 3D view and agent all share it. The pillar was
100% `rotate4`.

**J. Placement diagnostics** (P1).
- `ShapeRules.can_add` returns a reason code instead of a bool: `native_block`, `slot_taken`,
  `opposite_faces`, `micro_conflict`, `hard_box_overlap`, `fully_occluded`, `arch_exclusive`.
- `VoxelWorld.set_block` on a shaped semantic reports `shaped_semantic_needs_part`.
- The UI ghost can show the reason on hover too.

**K. Shape orientation vocabulary** (P1). `ShapeCatalog.slot_name` / `slot_from_name`.
`ArchShapes.describe(id, slot)` returns `{up, facing, principal face normals, text}`, and a solver
maps Orient constraints to a slot. This replaces the `arch_slot` normal-matching hack.

**L. Named regions** (P2). Project-tied editor state, like the selection: `pillar-1`,
`crown`. Useful for users, and for agents that come back to a build later.

**M. Checkpoints** (P2). Named snapshots of a project or region, separate from undo, used to
try a variant and roll back. Cheap for builds of this size.

**N. Stats and bill of materials** (P2). Counts by semantic and by block type. Microblocks count
as eighths, and `blocks_needed` rounds up per block type. For GTNH this is a shopping list. The
MC-specific part (FMP saw cuts, AC sawbench inputs) belongs in the export extension.

**O. Scratch projects and edit contexts** (scratch P1, contexts P3).
- P1: scratch projects are in memory only, not written until saved.
- P3: `VoxelWorld` edits currently assume `active_project`. Add an `EditContext` (project,
  history, selection, clipboard). The active one stays the default, and Claude can work in its
  own scratch context while the user keeps editing theirs. Promote with `region_stamp` across
  contexts. The Home screen shows the scratch project live, with its thumbnail updating.

**P. Templates** (P3).
- Save a region as a reusable, semantic-only structure: "Conduit Pillar" becomes a stamp you can
  place anywhere.
- A templates list in the UI (inventory tab or Home section) refreshes live as Claude saves
  templates.
- Stamping into a project whose palette uses different names asks for a semantic remap (a UI
  dialog, or a `semantic_map` param).
- Principle check: templates store intent only, never materials.

**Q. Presence UI** (P2 basics, P3 extras).
- An editor-bar badge ("Claude connected" / "Claude is building…"), pulsing highlights on regions
  being edited, and `notify_user` toasts.
- The **Pause Claude** button (§3.5).
- Stretch: a ghost of the agent's capture camera frustum in the user's 3D views.

**R. Turntable and flythrough export** (P3). N-frame orbit or path renders saved as GIF/WebP/MP4
for sharing builds. The agent gets a contact sheet of the frames.

**S. Reference images** (P3). Pin an inspiration image in a project, shown as a backdrop
billboard in 3D or placed next to renders in `capture_sheet`, so critique happens side by side.

**T. Pick from a capture** (P2). `capture_pick(capture_id, x, y)` re-raycasts from the stored
camera and returns the cell or part at that pixel. It answers "what is that dark wedge?" without
guessing.

---

## 6. Tool catalog

Names are unprefixed. Claude Code namespaces them as `mcp__voxyl__*`. About 50 tools with
consistent shapes (§4). Keep descriptions tight and point to `voxyl://conventions`.

### Session
| Tool | Does | Ph |
|---|---|---|
| `status` | App version, open project, focused view, selection, pause state, queued calls | P1 |
| `logs` | Recent Godot log/errors (`level`, `since`) | P1 |
| `notify_user` | Toast in the app | P2 |

### Libraries and blocks
| Tool | Does | Ph |
|---|---|---|
| `library_list` | Libraries with counts and source namespace | P1 |
| `block_search` | Filter by `query`, `library`, `color_near` (hex + tolerance), `tags`, `family` (e.g. all 16 of a ztones set); paged | P1 |
| `block_get` | Model, faces, texture ids, average color, which palettes use it | P1 |
| `block_swatches` | **Image**: labeled grid of blocks as lit cubes (`style: cube`) or flat textures. Replaces the contact-sheet and material-wall hacks | P1 |
| `library_rename` / `library_delete` | Mirror the UI; delete requires `confirm: true` | P2 |
| `mc_import_sources` / `mc_import_run` / `mc_import_status` | Extension group: list sources, import selected or all, report progress | P3 |

### Palettes
| Tool | Does | Ph |
|---|---|---|
| `palette_list` / `palette_get` | Entries (semantic → block, shape) and library stack | P1 |
| `palette_create` | Name, libraries and **bulk entries** in one call | P1 |
| `palette_update` | `add`, `remove`, `rename`, `set` (block and/or shape; `block: null` = undecided), `libraries` | P1 |
| `palette_delete` / `palette_duplicate` | Delete requires `confirm: true` | P2 |
| `palette_render` | **Image**: every entry's icon with its semantic name (reuses `BlockIconBaker`) | P1 |
| `project_palettes_set` | Set a project's palette stack order | P1 |

### Shapes
| Tool | Does | Ph |
|---|---|---|
| `shape_list` | Picker pages, families, sizes, slot scheme | P1 |
| `shape_describe` | One shape: slot table with names, boxes, and for architecture shapes the `up`/`facing` meaning. Optional **image** of the slots | P1 |
| `shape_orient` | Orient constraints → slot(s), with an explanation if ambiguous | P1 |

### Projects
| Tool | Does | Ph |
|---|---|---|
| `project_list` | Name, palettes, bounds, modified time, thumbnail path | P1 |
| `project_create` | `scratch: true` = in memory only; appears on the Home screen live | P1 |
| `project_open` / `project_info` | Open in the user's editor. Info: bounds, counts, palettes, named regions, history depth | P1 |
| `project_save` | Save, or `as: name` (promotes a scratch project) | P1 |
| `project_duplicate` / `project_rename` / `project_delete` | Delete requires `confirm: true` | P2 |

### Editing
Every tool here takes `project` (guard), `symmetry`, `repeat`, `dry_run` (validate only, report
conflicts) and `animate`. Each call is one undo step.

| Tool | Does | Ph |
|---|---|---|
| `cells_set` | `[{pos, semantic, orientation?}]` whole blocks | P1 |
| `parts_add` | `[{pos, PartSpec}]`, with a per-item reason when rejected | P1 |
| `cells_clear` | Positions or a Region (`parts_only`, `semantic` filter) | P1 |
| `cells_place_layers` | Text-codec authoring (§5-G): origin, legend, layers | P1 |
| `region_fill` | Region + semantic + style (`solid`/`hollow`/`walls`/`frame`/`floor`), `only_air` | P1 |
| `region_replace` | Semantic A → B in a region (the exchange tool) | P1 |
| `line` | From → to, a semantic or PartSpec (a strip along an edge run) | P2 |

### Selection, clipboard, transforms
| Tool | Does | Ph |
|---|---|---|
| `selection_set` / `selection_get` / `selection_clear` | The shared region selection all views show | P1 |
| `region_move` | Offset a region (cut + paste in one step) | P1 |
| `region_copy` / `clipboard_paste` | Paste takes `at`, `rotate`, `mirror` | P1 |
| `region_transform` | Rotate Y (90° steps) / mirror in place about a pivot | P2 |
| `region_stamp` | Copy to `to: [...]` or `array: Repeat`; optionally across projects | P2 |
| `region_name` / `regions_list` / `region_forget` | Named regions | P2 |

### Inspect
| Tool | Does | Ph |
|---|---|---|
| `cell_get` | Cell with parts (named slots) and resolved block/shape per part | P1 |
| `region_text` | Text dump (§5-G): `axis`, `at` or a range, `resolution` | P1 |
| `region_stats` | Counts by semantic and block, bounds, bill of materials | P1 (counts) / P2 (BOM) |
| `region_validate` | Every cell passes ShapeRules; lists undecided semantics; later, export checks | P2 |
| `project_diff` | Against a checkpoint: changed cells as text or JSON | P2 |

### History
| Tool | Does | Ph |
|---|---|---|
| `history` | `list` / `undo n` / `redo n` | P1 |
| `checkpoint` | `save name` / `restore name` / `list` / `drop` | P2 |

### Camera, capture, views
| Tool | Does | Ph |
|---|---|---|
| `capture` | **Image**: CameraSpec + RenderSpec, offscreen. Returns `capture_id`, camera report, saved path | P1 |
| `capture_sheet` | **Image**: many views composited with captions. `views: [...]` or `preset: review` (hero, eye-level look-up, front elevation, top, detail), `turntable`, `elevations`, or `compare` (same camera over N regions, for variants) | P1 (`review`, `compare`) / P2 (rest) |
| `capture_slice` | **Image**: the app's own 2D grid lens at an axis/index | P2 |
| `capture_pick` | Pixel → cell/part via a stored camera (§5-T) | P2 |
| `view_list` | Open views: id, kind (3D / slice), title, focused, camera, render settings | P1 |
| `view_set` | For a ViewRef: move its **camera** (CameraSpec, e.g. "look here") and/or change its **render / lighting / projection / section**. The view's toolbar updates live | P1 (camera) / P2 (render options) |
| `view_layout` | Open 3D or slice panes, presets, focus | P3 |

### Hotbar and tools (UI parity)
| Tool | Does | Ph |
|---|---|---|
| `hotbar_set` | Fill hotbar slots with semantics | P1 |
| `tool_set` | Active tool + brush size, e.g. to hand the user a ready-to-use setup | P3 |

### Templates (P3)
`template_save` · `template_list` · `template_stamp {name, at, rotate, mirror, semantic_map}` ·
`template_delete {confirm}`

---

## 7. Phases and acceptance

**P1: "Replay the Pillar."**
- In-app MCP server (HTTP, JSON responses), Settings dialog + `AppSettings`, tool registry.
- The live-update audit (§3.4) with its tests, the view toolbar skeleton, and CaptureService
  stage 1.
- Camera framing, labeled sheets, the text codec at 1-cell resolution, placement diagnostics,
  orientation vocabulary, scratch projects, and the P1 tools.

Acceptance, in a fresh Claude session with Voxyl open and agent connections enabled:
- Rebuild the Conduit Pillar from nothing: choose materials, create the palette, build, review
  renders, check a colonnade, save.
- The user watches it happen: blocks appear in their 3D view, and the new palette appears in the
  inventory and palette editor, with no refresh.
- Nothing installed besides Voxyl and Claude Code. No scratchpad scripts. No files written
  outside Voxyl's own saves. No leaked probe projects.
- Every rejected placement comes with a reason.
- About 25–40 tool calls in total. The experiment needed about 20 script edits and runs, plus
  custom geometry code.

**P2: "Design instruments."** SSE (progress, resource updates), render modes (intent, clay,
outline, xray, wire) and the full toolbar, ortho and elevations, studio lighting,
section/isolate, transforms, array/stamp, symmetry editing mode for users, named regions,
checkpoints, BOM, pick, presence basics, sub-cell text resolution, and the remaining CRUD.

**P3: "Sky's the limit."** Neon mode with emissive blocks and bloom, CaptureService stage 2
(shared renderer, capture any project), edit contexts, templates, turntable and flythrough
export, reference images, the MC import tool group, and export validation hooks (shaped-parts
Part 5).

**Testing**
- `tests/McpTest.gd` starts the server on a test port and uses Godot's `HTTPClient` as the MCP
  client. It checks `initialize` → `tools/list` → `tools/call` round-trips, token and `Origin`
  rejection, keep-alive, big-payload writes, and a pillar rebuild asserting cell contents.
  Headless works for everything except captures.
- Capture tests need a windowed run behind `tests/run_tests.sh --with-render`.
- Signal-coverage and UI-refresh tests (§3.4).
- `CLAUDE.md` workflow still applies: `tools/validate-scripts.sh` + `tests/run_tests.sh` before
  commits.

---

## 8. Appendix: the pillar replayed as MCP calls (sketch)

```jsonc
status                    // → {project:null, views:[…], paused:false}
block_search    {library:"gtnh.ztones", family:"korp"}
block_swatches  {blocks:["sets/korp/korp_ (3)","sets/korp/korp_ (4)","sets/korp/korp_ (11)",
                 "sets/iszm/iszm_ (8)","gray_concrete","white_concrete"], style:"cube"}   // image
palette_create  {name:"Conduit Pillar", libraries:["gtnh.ztones","minecraft"], entries:[
                  {semantic:"Core", block:"sets/korp/korp_ (3)"},
                  {semantic:"Mass", block:"sets/korp/korp_ (4)"},
                  {semantic:"Channel Glow", block:"sets/iszm/iszm_ (8)", shape:"face4"},
                  {semantic:"Channel Edge", block:"white_concrete", shape:"edge1"},
                  {semantic:"Plinth Chamfer", block:"gray_concrete", shape:"roof_tile"} /* … */]}
                          // user sees the palette appear in their inventory
project_create  {name:"Conduit Pillar", palettes:["Conduit Pillar"], scratch:true}
project_open    {name:"Conduit Pillar"}      // opens in the user's editor
cells_place_layers {project:"Conduit Pillar", origin:[-2,3,-2],
                    symmetry:{rotate4:{center:[0,0]}}, repeat:{count:13, step:[0,1,0]},
                    legend:{"M":"Mass","C":"Core",
                            "r":[{semantic:"Corner Rod", slot:"north-west"}],
                            "g":[{semantic:"Channel Glow", slot:"north"},
                                 {semantic:"Channel Edge", slot:"south-west"},
                                 {semantic:"Channel Edge", slot:"south-east"}]},
                    // rows north→south (z −2..2), chars west→east (x −2..2); only the south
                    // face + its corner is drawn, rotate4 fills the other three faces.
                    // Joint rows (y 6, 10) are a second call with a different legend.
                    layers:[[".....", ".....", "..C..", "..CC.", ".MgMr"]]}
parts_add       {items:[{pos:[-2,1,3], semantic:"Plinth Chamfer", orient:{up:"+y", facing:"south"}}],
                 symmetry:{rotate4:{center:[0,0]}}, repeat:{count:5, step:[1,0,0]}}
capture_sheet   {preset:"review", frame:{all:true}}                          // textured
capture         {frame:{all:true}, from:"se", elevation:"low", render:{mode:"xray"}}
region_text     {region:{all:true}, axis:"y", at:8, resolution:2}           // channel depth check
checkpoint      {save:"single"}
region_stamp    {region:{all:true}, array:{count:[3,1,2], step:[16,0,16]}}  // colonnade check
capture         {frame:{all:true}, camera:{elevation:"eye", from:"sw"}, fov:75}
checkpoint      {restore:"single"}
project_save    {as:"Conduit Pillar"}
view_set        {view:"focused", camera:{frame:{all:true}, from:"se", elevation:8}}  // hand it over
```

---

## 9. Open questions

1. **Token default.** Require the bearer token by default, as proposed? It's safer, but setup is
   one paste longer. The Copy button makes that painless.
2. **Stdio-only clients** (e.g. some desktop apps) could only connect through a third-party
   HTTP-to-stdio bridge, which means an install. Is it OK to leave them out? An in-app stdio mode
   would mean Voxyl launching as a separate process, which breaks attach.
3. **Templates.** Same as the "templates" the user mentioned? Here they're semantic-only stamps
   saved from a region.
4. **Scratch project visibility.** Should scratch projects show on the Home screen (marked
   "unsaved"), or stay hidden until saved? The plan shows them, for live visibility.
