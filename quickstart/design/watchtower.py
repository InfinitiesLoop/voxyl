"""Watchtower build, as an agent would write it from the reference photo (assets/watchtower-reference.webp).

    quickstart/.venv/Scripts/python.exe quickstart/design/watchtower.py

writes quickstart/chapters/watchtower.build.json: a palette plus build steps, each a list of the
MCP tool calls (cells_place_layers) a Voxyl agent would send. The agent chapter replays them in the
real app, so what the video shows being built is exactly what these calls build.

Everything is semantic ("Tower Stone", "Roof Slate"): the Castle palette maps those to vanilla blocks,
and can be swapped without touching a voxel.
"""
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "chapters" / "watchtower.build.json"

PALETTE = [
    ("Tower Stone", "stone_bricks"),
    ("Tower Stone Worn", "cracked_stone_bricks"),
    ("Tower Stone Moss", "mossy_stone_bricks"),
    ("Tower Stone Light", "cut_sandstone"),
    ("Corbel", "chiseled_stone_bricks"),
    ("Merlon", "stone_bricks"),
    ("Paving", "polished_andesite"),
    ("Roof Slate", "deepslate_tiles"),
    ("Roof Edge", "polished_blackstone_bricks"),
    ("Slit", "blackstone"),
    ("Shutter", "mangrove_planks"),
    ("Door", "spruce_planks"),
    ("Timber", "dark_oak_planks"),
    ("Plaster", "calcite"),
    ("Window", "glass_pane"),
    ("Railing", "dark_oak_fence"),
    ("Vane", "iron_bars"),
    ("Rock", "cobblestone"),
    ("Rock Dark", "andesite"),
    ("Rock Moss", "moss_block"),
    ("Grass", "grass_block"),
]


def h01(x, y, z, salt=0):
    """A repeatable pseudo-random number in [0, 1) for a cell."""
    n = (x * 73856093) ^ (y * 19349663) ^ (z * 83492791) ^ (salt * 2654435761 & 0xFFFFFFFF)
    n &= 0xFFFFFFFF
    n = ((n ^ (n >> 13)) * 1274126177) & 0xFFFFFFFF
    n ^= n >> 16
    return (n & 0xFFFF) / 65536.0


def stone(x, y, z, light_every=7):
    """Tower masonry: mostly plain bricks, some cracked and mossy, and a lighter string course."""
    if light_every and y % light_every == 0:
        return "Tower Stone Light"
    r = h01(x, y, z)
    moss_bias = 0.08 if y < 10 else 0.02
    if r < moss_bias:
        return "Tower Stone Moss"
    if r < moss_bias + 0.16:
        return "Tower Stone Worn"
    return "Tower Stone"


def radius(x, z):
    return math.hypot(x, z)


def ring(r_out, r_in):
    """Cell columns whose centre is between two radii around the tower axis."""
    n = int(math.ceil(r_out)) + 1
    for x in range(-n, n + 1):
        for z in range(-n, n + 1):
            d = radius(x, z)
            if d <= r_out + 0.35 and d > r_in + 0.35:
                yield x, z


def disk(r):
    return ring(r, -1.0)


def segment(x, z, count):
    """Which of `count` equal slices of the circle a column falls in (for alternating merlons)."""
    a = math.atan2(z, x) % (2 * math.pi)
    return int(a / (2 * math.pi) * count)


# ------------------------------------------------------------------ components

def rock_base():
    cells = {}
    for x in range(-22, 24):
        for z in range(-18, 19):
            d = radius(x * 0.9, z)
            if d <= 6.4:
                continue                                  # the tower stands here
            reach = 17.0 if x < -4 else 13.5              # the west side drops away more steeply, like the photo
            if d >= reach:
                continue
            height = 5.2 * (1.0 - d / reach) ** 0.9 + (h01(x, 0, z, 3) - 0.5) * 1.5
            h = max(1, int(round(height)))
            if x > 5 and abs(z) <= 3:
                continue                                  # the wall's footing is laid separately
            for y in range(0, h):
                r = h01(x, y, z, 5)
                cells[(x, y, z)] = "Rock Dark" if r < 0.35 else "Rock"
            top = h - 1
            r = h01(x, top, z, 9)
            if r < 0.40:
                cells[(x, top, z)] = "Rock Moss"
            elif r < 0.62:
                cells[(x, top, z)] = "Grass"
    for x in range(5, 27):                                # the wall's footing, running east
        for z in range(-3, 4):
            for y in range(0, 1 + (1 if h01(x, 0, z, 11) < 0.35 else 0)):
                cells[(x, y, z)] = "Rock Dark" if h01(x, y, z, 5) < 0.3 else "Rock"
    for z in range(6, 14):                                # a paved path up to the door
        for x in (-1, 0, 1):
            for y in range(1, 6):
                cells.pop((x, y, z), None)
            cells[(x, 0, z)] = "Paving"
    return cells


def tower_shaft():
    cells = {}
    for x, z in disk(6.3):
        cells[(x, 0, z)] = "Tower Stone Worn"                                # foundation
    for y in range(1, 4):                                                    # a battered plinth
        for x, z in ring(6.3, 4.0):
            cells[(x, y, z)] = stone(x, y, z, 0)
    for y in range(4, 23):                                                   # the shaft: two blocks thick
        for x, z in ring(5.3, 3.3):
            cells[(x, y, z)] = stone(x, y, z)
    return cells


def openings(tower):
    """Arrow slits up the shaft, in staggered columns, and the door."""
    cells = {}
    for level, y0 in enumerate((7, 12, 17)):
        for k in range(4):
            a = math.radians(45.0 * (2 * k + 1) + (0 if level % 2 == 0 else 45.0))
            x = round(5.3 * math.cos(a))
            z = round(5.3 * math.sin(a))
            for y in (y0, y0 + 1):
                for rr in (5.3, 4.3):
                    cx, cz = round(rr * math.cos(a)), round(rr * math.sin(a))
                    if (cx, y, cz) in tower:
                        cells[(cx, y, cz)] = "Slit"
    for level, y0 in enumerate((7, 12)):                                     # wooden shutters either side of the lower slits
        for k in range(4):
            a = math.radians(45.0 * (2 * k + 1) + (0 if level % 2 == 0 else 45.0))
            tx, tz = -math.sin(a), math.cos(a)                               # along the wall, round the tower
            for side in (-1, 1):
                for y in (y0, y0 + 1):
                    cx = round(5.3 * math.cos(a) + side * 1.4 * tx)
                    cz = round(5.3 * math.sin(a) + side * 1.4 * tz)
                    if (cx, y, cz) in tower and (cx, y, cz) not in cells:
                        cells[(cx, y, cz)] = "Shutter"
    for y in range(1, 5):                                                    # the door, facing south
        for x in (-1, 0, 1):
            for z in (5, 6, 4):
                if (x, y, z) in tower:
                    cells[(x, y, z)] = "Door" if y < 4 else "Tower Stone Light"
    return cells


def machicolations():
    cells = {}
    for x, z in ring(6.9, 5.2):                                              # corbels carrying the parapet
        if segment(x, z, 26) % 2 == 0:
            cells[(x, 22, z)] = "Corbel"
    for x, z in disk(7.4):                                                   # the deck
        cells[(x, 23, z)] = "Tower Stone Light"
    for x, z in ring(7.4, 6.3):                                              # parapet wall
        cells[(x, 24, z)] = stone(x, 24, z, 0)
    for y in (25, 26):                                                       # merlons
        for x, z in ring(7.4, 6.3):
            if segment(x, z, 24) % 2 == 0:
                cells[(x, y, z)] = "Merlon"
    return cells


def turret_and_roof():
    cells = {}
    for y in range(24, 31):
        for x, z in ring(4.3, 2.9):
            cells[(x, y, z)] = stone(x, y, z, 0)
    for a in (0, 90, 180, 270):                                              # small windows
        x, z = round(4.2 * math.cos(math.radians(a))), round(4.2 * math.sin(math.radians(a)))
        for rr in (4.3, 3.3):
            cx, cz = round(rr * math.cos(math.radians(a))), round(rr * math.sin(math.radians(a)))
            cells[(cx, 27, cz)] = "Slit"
            cells[(cx, 28, cz)] = "Slit"
    r = 5.7                                                                  # the cone
    y = 31
    while r > 0.45:
        for x, z in disk(r):
            cells[(x, y, z)] = "Roof Slate"
        if y == 31:
            for x, z in ring(r, r - 1.2):
                cells[(x, y, z)] = "Roof Edge"
        r -= 0.44
        y += 1
    for yy in range(y, y + 5):                                               # weather vane
        cells[(0, yy, 0)] = "Vane"
    cells[(1, y + 3, 0)] = "Vane"
    return cells


def curtain_wall():
    cells = {}
    for x in range(4, 27):
        for z in range(-2, 3):
            for y in range(1, 13):
                if x < 7 and radius(x, z) < 5.4:
                    continue                                                 # inside the tower
                cells[(x, y, z)] = stone(x, y, z)
            cells[(x, 13, z)] = "Paving" if abs(z) < 2 else "Tower Stone Light"
    for x in range(8, 27):                                                   # arrow slits on the south face
        if x % 6 == 4:
            for y in (7, 8):
                cells[(x, y, 2)] = "Slit"
    for pier_x in (11, 19):                                                  # two piers on the south face
        for x in (pier_x, pier_x + 1):
            for y in range(1, 15):
                cells[(x, y, 3)] = stone(x, y, 3)
            cells[(x, 15, 3)] = "Merlon"
    for x in range(7, 27):                                                   # merlons on the south parapet
        if x % 3 in (0, 1):
            for y in (14, 15):
                cells[(x, y, 2)] = "Merlon"
        cells[(x, 14, -2)] = "Railing" if x % 2 == 0 else "Railing"          # a rail along the north edge
    for x in range(7, 27, 4):
        cells[(x, 15, -2)] = "Railing"
    return cells


def hut():
    cells = {}
    x0, x1 = 19, 23
    for x in range(x0, x1 + 1):
        for z in (-1, 0, 1):
            for y in range(14, 18):
                edge_x = x in (x0, x1)
                edge_z = z in (-1, 1)
                post = (edge_x and edge_z) or (x == (x0 + x1) // 2 and edge_z)
                beam = y in (14, 17)
                if edge_x or edge_z:
                    cells[(x, y, z)] = "Timber" if (post or beam) else "Plaster"
    for y in (15, 16):                                                       # a window on the south wall, a door west
        cells[((x0 + x1) // 2 - 1, y, 1)] = "Window"
        cells[((x0 + x1) // 2 + 1, y, 1)] = "Window"
    cells[(x0, 14, 0)] = "Door"
    cells[(x0, 15, 0)] = "Door"
    for x in range(x0 - 1, x1 + 2):                                          # gable roof, ridge along x
        for z in range(-2, 3):
            cells[(x, 18, z)] = "Roof Slate"
        for z in range(-1, 2):
            cells[(x, 19, z)] = "Roof Slate"
        cells[(x, 20, 0)] = "Roof Edge"
    return cells


# ------------------------------------------------------------------ output

def to_layers(cells, legend_names):
    xs = [c[0] for c in cells]
    ys = [c[1] for c in cells]
    zs = [c[2] for c in cells]
    x0, y0, z0 = min(xs), min(ys), min(zs)
    chars = {}
    pool = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    for name in sorted({v for v in cells.values()}):
        chars[name] = pool[len(chars)]
    layers = []
    for y in range(y0, max(ys) + 1):
        rows = []
        for z in range(z0, max(zs) + 1):
            rows.append("".join(chars.get(cells.get((x, y, z)), ".") for x in range(x0, max(xs) + 1)))
        layers.append(rows)
    return {"origin": [x0, y0, z0], "axis": "y", "legend": {c: n for n, c in chars.items()}, "layers": layers}


def step(label, detail, cells):
    return {"label": label, "detail": detail, "cells": len(cells),
            "calls": [{"tool": "cells_place_layers", "args": to_layers(cells, None)}]}


# ------------------------------------------------------------------ the iteration: "add a pond near the
# entrance and make the tower a bit taller", done with the advanced editing tools (move / copy / paste a
# slice) rather than rebuilding.

POND_PALETTE = [("Water", "light_blue_stained_glass"), ("Lily Pad", "lily_pad"), ("Pond Rim", "mossy_cobblestone")]
RISE = 3


def pond_layers():
    cx, cz, ra, rb = 7.0, 10.5, 5.2, 3.8
    x0, x1, z0, z1 = 2, 12, 7, 14
    chars = {"W": "Water", "R": "Pond Rim", "L": "Lily Pad"}
    layers = []
    for y in range(0, 6):
        rows = []
        for z in range(z0, z1 + 1):
            row = ""
            for x in range(x0, x1 + 1):
                e = ((x - cx) / ra) ** 2 + ((z - cz) / rb) ** 2
                inside, rim = e <= 1.0, 1.0 < e <= 1.55
                if y == 0:
                    row += "W" if inside else ("R" if rim else ".")
                elif y == 1:
                    if inside:
                        row += "L" if h01(x, 1, z, 21) < 0.2 else "_"
                    elif rim:
                        row += "R" if h01(x, 1, z, 22) < 0.65 else "_"
                    else:
                        row += "."
                else:
                    row += "_" if (inside or rim) else "."          # clear the mound above the pond
            rows.append(row)
        layers.append(rows)
    return {"origin": [x0, 0, z0], "axis": "y", "legend": chars, "layers": layers}


def iteration():
    top = {"min": [-9, 22, -9], "max": [9, 52, 9]}
    steps = [
        {"label": "Pond materials", "detail": "Water · Lily Pad · Pond Rim",
         "calls": [{"tool": "palette_update", "args": {"name": "Castle", "add": [{"semantic": s_, "block": b} for s_, b in POND_PALETTE]}}]},
        {"label": "Pond by the door", "detail": "dig the mound, fill with Water",
         "calls": [{"tool": "cells_place_layers", "args": pond_layers()}]},
        {"label": "Lift the top", "detail": "everything above y=22, up %d" % RISE,
         "calls": [{"tool": "region_move", "args": {"region": top, "by": [0, RISE, 0]}}]},
        {"label": "Copy a slice of wall", "detail": "3 layers of the shaft",
         "calls": [{"tool": "region_copy", "args": {"region": {"min": [-7, 19, -7], "max": [7, 21, 7]}}}]},
        {"label": "Fill the gap", "detail": "paste it under the deck",
         "calls": [{"tool": "clipboard_paste", "args": {"at": [-7, 22, -7]}}]},
    ]
    return steps


def main():
    tower = tower_shaft()
    steps = [
        step("Rock outcrop", "Rock · Rock Dark · Rock Moss", rock_base()),
        step("Tower shaft", "Tower Stone · plinth + 2-thick walls", tower),
        step("Slits and door", "Slit · Door", openings(tower)),
        step("Machicolations", "Corbel · Merlon · deck", machicolations()),
        step("Turret and roof", "Roof Slate · Vane", turret_and_roof()),
        step("Curtain wall", "Paving · Merlon · Railing", curtain_wall()),
        step("Timber hut", "Timber · Plaster · Window", hut()),
    ]
    data = {"palette": {"name": "Castle", "libraries": ["minecraft"],
                        "entries": [{"semantic": s, "block": b} for s, b in PALETTE]},
            "steps": steps, "iteration": iteration()}
    OUT.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    total = sum(s["cells"] for s in steps)
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB): {len(steps)} steps, {total} cells")
    for s in steps:
        print(f"  {s['label']:<18} {s['cells']:>5} cells")


if __name__ == "__main__":
    main()
