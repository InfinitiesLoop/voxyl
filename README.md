# voxyl

> Build worlds. Plan anything. See everything.

Voxyl is a voxel scene editor built for the way creative builders actually think — not the way software engineers assume they do.

Most voxel tools force you to make decisions you're not ready to make. What block is this? What color? What material? Voxyl flips this on its head: **build first, decide later**. Lay out your entire structure using semantic roles — *base*, *accent*, *trim*, *highlight* — and swap in your actual palette whenever you're ready. Change your mind? Change the palette. The data doesn't care.

## The Big Idea

Voxyl separates **what you're building** from **what it looks like**. Your voxel data stores intent, not materials. A block is a "structural accent" before it's ever an oak log or a polished blackstone brick. This means:

- You can plan a build before you've decided on a color scheme
- You can try five different palettes on the same structure in seconds
- You can share your layout with someone who uses completely different materials

## Multiple Views, One Truth

There is no "the view" in Voxyl. There is only the data, and the lens you're looking at it through right now.

- **2D Grid View** — click cells layer by layer. Fast, precise, great for planning floor layouts and cross-sections.
- **3D View** *(coming)* — walk through your build as if you're in the world. Place and remove blocks in context.
- **More to come** — top-down overview, section cuts, material usage stats. Every view reads the same data. Every edit in any view is immediately reflected in all the others.

## Not Just Minecraft

Voxyl was born from the chaos of planning large Minecraft builds — massive factories, sprawling cities, intricate mega-bases — where you need to think architecturally before you think materially. But there's nothing Minecraft-specific about it. Any voxel-based creative work benefits from the same approach: palette-driven design, multi-view editing, and a clean separation between structure and style.

## Status

Early development. The foundation is in place: core data model, palette system, and the first view (2D grid editor). The architecture is deliberately designed so that new views are trivially addable — they're just different lenses on the same underlying world.

This is going to be something.
