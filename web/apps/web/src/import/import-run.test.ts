import { type ByteSource, bytesSource, type FsDir, type FsFile } from "@voxyl/mc-import";
import { LibraryStore, MemoryFolder } from "@voxyl/session";
import { describe, expect, it } from "vitest";
import { importAndStore, reportOf } from "./import-run.ts";

const utf8 = { encode: (text: string) => new TextEncoder().encode(text) };

/** zlib-compressed bytes, as a PNG's IDAT holds them. */
async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// A tiny modpack folder in memory: two mods with one block each, and NEI's three dumps.

const ITEM = "Name,ID,Has Block,Mod,Class,Display Name";
const PANEL = "Item Name,Item ID,Item meta,Has NBT,Display Name";
const BLOCK = "Name,ID,Has Item,Mod,Class,Display Name";

/** A stored (uncompressed) zip of these files. */
function zip(files: Record<string, Uint8Array | string>): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = typeof content === "string" ? utf8.encode(content) : content;
    const nameBytes = utf8.encode(name);
    const local = new Uint8Array(30 + nameBytes.length + raw.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint32(18, raw.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(raw, 30 + nameBytes.length);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint32(20, raw.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const dirSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, dirSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + dirSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** An 8-bit RGBA PNG of one colour, 16 by 16. */
async function solidPng(r: number, g: number, b: number): Promise<Uint8Array> {
  const rows = new Uint8Array(16 * (16 * 4 + 1));
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) rows.set([r, g, b, 255], y * 65 + 1 + x * 4);
  const idat = await deflate(rows);
  const chunk = (kind: string, body: Uint8Array) => {
    const c = new Uint8Array(12 + body.length);
    new DataView(c.buffer).setUint32(0, body.length);
    c.set(utf8.encode(kind), 4);
    c.set(body, 8);
    return c;
  };
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, 16);
  hv.setUint32(4, 16);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const parts = [
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const file = (name: string, bytes: Uint8Array): FsFile => ({
  name,
  open: async (): Promise<ByteSource> => bytesSource(bytes),
});
const dir = (name: string, dirs: FsDir[] = [], files: FsFile[] = []): FsDir => ({
  name,
  list: async () => ({ dirs, files }),
});

async function instance(): Promise<FsDir> {
  const widget = zip({ "assets/testmod/textures/blocks/widget.png": await solidPng(200, 30, 30) });
  const gadget = zip({ "assets/othermod/textures/blocks/gadget.png": await solidPng(30, 30, 200) });
  const csv = (...rows: string[]) => utf8.encode(rows.join("\n"));
  return dir("pack", [
    dir("mods", [], [file("testmod.jar", widget), file("othermod.jar", gadget)]),
    dir(
      "dumps",
      [],
      [
        file(
          "item.csv",
          csv(
            ITEM,
            "testmod:widget,100,true,Test Mod,c,Widget",
            "othermod:gadget,101,true,Other Mod,c,Gadget",
          ),
        ),
        file(
          "itempanel.csv",
          csv(PANEL, "testmod:widget,100,0,false,Widget", "othermod:gadget,101,0,false,Gadget"),
        ),
        file(
          "block.csv",
          csv(
            BLOCK,
            "testmod:widget,100,true,Test Mod,c,Widget",
            "othermod:gadget,101,true,Other Mod,c,Gadget",
          ),
        ),
      ],
    ),
  ]);
}

const run = (folder: MemoryFolder, prefix: string, picked: FsDir) =>
  importAndStore({ picked, folder, prefix, onProgress: () => {} });

describe("importing a modpack folder", () => {
  it("puts the user's prefix on every library's id and name", async () => {
    const folder = new MemoryFolder();
    const report = await run(folder, "gtnh-", await instance());
    expect(report.libraries.map((l) => l.id).sort()).toEqual(["gtnh-othermod", "gtnh-testmod"]);
    expect(report.libraries.map((l) => l.name).sort()).toEqual(["gtnh-Other Mod", "gtnh-Test Mod"]);
    const stored = await new LibraryStore(folder).loadAll();
    expect(stored.map((l) => l.name).sort()).toEqual(["gtnh-Other Mod", "gtnh-Test Mod"]);
  });

  it("updates in place when the same folder is imported again", async () => {
    const folder = new MemoryFolder();
    const picked = await instance();
    const first = await run(folder, "pack-", picked);
    const filesAfterFirst = [...folder.files.keys()].sort();
    const second = await run(folder, "pack-", picked);
    expect(second).toEqual({ ...first, ms: second.ms });
    const store = new LibraryStore(folder);
    const stored = await store.loadAll();
    expect(stored).toHaveLength(2);
    expect(new Set(stored.map((l) => l.id)).size).toBe(2);
    expect([...folder.files.keys()].sort()).toEqual(filesAfterFirst);
    const blocks = stored.flatMap((l) => Object.keys(l.blocks));
    expect(blocks.sort()).toEqual(["Gadget", "Widget"]);
  });

  it("keeps another prefix's libraries apart from this one's", async () => {
    const folder = new MemoryFolder();
    const picked = await instance();
    await run(folder, "a-", picked);
    await run(folder, "b-", picked);
    const ids = (await new LibraryStore(folder).loadAll()).map((l) => l.id).sort();
    expect(ids).toEqual(["a-othermod", "a-testmod", "b-othermod", "b-testmod"]);
  });
});

describe("reportOf", () => {
  const result = (vanilla: boolean) => ({
    libraries: [],
    vanilla,
    imported: 0,
    dropped: 12,
    droppedByMod: { Minecraft: 9, Foo: 3 },
    healed: [],
    warnings: [
      "no assets found for mod namespace: minecraft (its blocks are dropped, not imported)",
      "no texture match, dropped: 9 block(s) in Minecraft",
      "no texture match, dropped: 3 block(s) in Foo",
    ],
    ms: 1,
  });

  it("says nothing about vanilla blocks when no Minecraft jar was read", () => {
    const report = reportOf(result(false));
    expect(report.droppedByMod).toEqual([["Foo", 3]]);
    expect(report.dropped).toBe(3);
    expect(report.warnings).toBe(1);
  });

  it("reports them when a Minecraft jar was read", () => {
    const report = reportOf(result(true));
    expect(report.dropped).toBe(12);
    expect(report.warnings).toBe(3);
  });
});
