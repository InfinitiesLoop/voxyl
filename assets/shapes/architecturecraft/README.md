# ArchitectureCraft shape geometry

These `.objson` triangle meshes are the shape models from **ArchitectureCraft** by Greg
Ewing (gcewing), as maintained in the GT New Horizons fork:

- Source: https://github.com/GTNewHorizons/ArchitectureCraft
  (`src/main/resources/assets/architecturecraft/models/shape/`, commit
  `946ed0e4455e2bcc6c14bc668553b246c6f73a18`)
- License: MIT — see `LICENSE` in this folder (must stay alongside the files).

They're used unchanged as the geometry for voxyl's architecture shapes (see
`scripts/core/ArchShapes.gd` and `.plans/shaped-parts.md`). Only the models voxyl's shape
catalog references are included.

Format (per file): `bounds` (min/max xyz, block-centered, -0.5..0.5), `boxes` (collision
boxes, same space), and `faces`: each `{ texture, vertices, triangles }`, where a vertex is
`[x, y, z, nx, ny, nz, u, v]` and `texture` is 0 = base material with the model's UVs,
1 = base material projected by face direction, 2/3 = the same for a secondary material.
