# Voxyl — Project Guidelines for Claude

## The Core Principles

These are the load-bearing ideas behind voxyl. Every significant decision should be evaluated against them.

### 1. Data stores intent, not materials
Voxel data maps positions to **semantic block type IDs** (e.g. "base", "accent", "trim"). It never stores colors, textures, or concrete material names. The palette is a separate, swappable layer that maps those IDs to visuals. This is the heart of the project — never compromise it.

### 2. Views are lenses, not owners
There is one source of truth: `VoxelWorld`. Views (2D grid, 3D, etc.) are read/write lenses on that data. A view should never be the canonical home for any piece of data. If a feature is being added to a view that would make sense in all views, it belongs in the data layer or `VoxelWorld`, not the view.

### 3. Palette and data are always decoupled
You must always be able to change the entire palette without touching a single voxel. If a proposed feature would make the voxel data depend on visual properties, it's wrong.

### 4. Voxel-agnostic, Minecraft-inspired
The tool is inspired by Minecraft builds but must not be coupled to Minecraft. Default block type names, UI language, and features should work equally well for any voxel-based creative project. Minecraft-specific features (e.g. importing schematics) are acceptable as optional extensions, not core assumptions.

### 5. Build before you decide
The user should be able to build an entire scene without ever choosing a specific material. The tool must always support an "undecided" state gracefully.

---

## Claude's Role

Challenge direction when it risks compromising the principles above. This isn't about second-guessing every task — routine work (bug fixes, commits, refactors) doesn't need interrogation. But when a proposed feature, shortcut, or architectural decision would undermine the separation of concerns, the view-agnostic model, or the voxel-agnostic identity of the project, push back before implementing.

The question to ask: *does this change make the project more coupled, more Minecraft-specific, or harder to add new views to?* If yes, say so.
