// A minimal big-endian NBT writer and reader: the container format every Minecraft data file
// uses (a named root compound), with no Minecraft knowledge in it (schematica.ts has that).
// Port of the Godot app's NbtWriter.gd / NbtReader.gd. Gzip is a separate step (gzip.ts), so
// this file is plain bytes in, plain bytes out.
//
// A tag is a small tagged object built with the helpers below, so a typo in a type name fails
// to compile instead of writing a corrupt file. A compound's fields are written in insertion
// order, which keeps output stable.

/** A compound's fields. */
export type Compound = Record<string, Tag>;

export type Tag =
  | { readonly type: "byte"; readonly value: number }
  | { readonly type: "short"; readonly value: number }
  | { readonly type: "int"; readonly value: number }
  | { readonly type: "long"; readonly value: bigint }
  | { readonly type: "float"; readonly value: number }
  | { readonly type: "double"; readonly value: number }
  | { readonly type: "byteArray"; readonly value: Uint8Array }
  | { readonly type: "string"; readonly value: string }
  | { readonly type: "list"; readonly itemType: ListItemType; readonly items: readonly ListItem[] }
  | { readonly type: "compound"; readonly value: Compound }
  | { readonly type: "intArray"; readonly value: Int32Array };

/** What a list's items are. Compound items are a compound's fields, with no name or header. */
export type ListItemType = Exclude<Tag["type"], "list" | "byteArray" | "intArray"> | "end";
export type ListItem = number | bigint | string | Compound;

const IDS = {
  end: 0,
  byte: 1,
  short: 2,
  int: 3,
  long: 4,
  float: 5,
  double: 6,
  byteArray: 7,
  string: 8,
  list: 9,
  compound: 10,
  intArray: 11,
} as const;
const NAMES = Object.fromEntries(Object.entries(IDS).map(([name, id]) => [id, name])) as Record<
  number,
  keyof typeof IDS
>;

export const nbt = {
  byte: (value: number): Tag => ({ type: "byte", value }),
  short: (value: number): Tag => ({ type: "short", value }),
  int: (value: number): Tag => ({ type: "int", value }),
  long: (value: bigint): Tag => ({ type: "long", value }),
  float: (value: number): Tag => ({ type: "float", value }),
  double: (value: number): Tag => ({ type: "double", value }),
  string: (value: string): Tag => ({ type: "string", value }),
  byteArray: (value: Uint8Array): Tag => ({ type: "byteArray", value }),
  intArray: (value: Int32Array): Tag => ({ type: "intArray", value }),
  compound: (value: Compound = {}): Tag => ({ type: "compound", value }),
  list: (itemType: ListItemType, items: readonly ListItem[] = []): Tag => ({
    type: "list",
    itemType,
    items,
  }),
};

// --- Text and growable bytes, without DOM or Node types ---

const runtime = globalThis as unknown as {
  TextEncoder: new () => { encode(text: string): Uint8Array };
  TextDecoder: new () => { decode(bytes: Uint8Array): string };
};
const encoder = new runtime.TextEncoder();
const decoder = new runtime.TextDecoder();

class Sink {
  bytes = new Uint8Array(4096);
  view = new DataView(this.bytes.buffer);
  length = 0;

  reserve(n: number): void {
    if (this.length + n <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.bytes.subarray(0, this.length));
    this.bytes = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): void {
    this.reserve(1);
    this.view.setUint8(this.length++, v);
  }
  i8(v: number): void {
    this.reserve(1);
    this.view.setInt8(this.length++, v);
  }
  i16(v: number): void {
    this.reserve(2);
    this.view.setInt16(this.length, v);
    this.length += 2;
  }
  u16(v: number): void {
    this.reserve(2);
    this.view.setUint16(this.length, v);
    this.length += 2;
  }
  i32(v: number): void {
    this.reserve(4);
    this.view.setInt32(this.length, v);
    this.length += 4;
  }
  i64(v: bigint): void {
    this.reserve(8);
    this.view.setBigInt64(this.length, v);
    this.length += 8;
  }
  f32(v: number): void {
    this.reserve(4);
    this.view.setFloat32(this.length, v);
    this.length += 4;
  }
  f64(v: number): void {
    this.reserve(8);
    this.view.setFloat64(this.length, v);
    this.length += 8;
  }
  raw(b: Uint8Array): void {
    this.reserve(b.length);
    this.bytes.set(b, this.length);
    this.length += b.length;
  }
}

// --- Writing ---

/** A complete NBT file (not compressed): one named root compound. */
export function writeNbt(rootName: string, fields: Compound): Uint8Array {
  const out = new Sink();
  header(out, "compound", rootName);
  compoundBody(out, fields);
  return out.bytes.slice(0, out.length);
}

function header(out: Sink, type: keyof typeof IDS, name: string): void {
  out.u8(IDS[type]);
  text(out, name);
}

function text(out: Sink, value: string): void {
  const bytes = encoder.encode(value);
  if (bytes.length > 0xffff) throw new RangeError("An NBT string is at most 65535 bytes");
  out.u16(bytes.length);
  out.raw(bytes);
}

function compoundBody(out: Sink, fields: Compound): void {
  for (const [name, tag] of Object.entries(fields)) {
    header(out, tag.type, name);
    payload(out, tag);
  }
  out.u8(IDS.end);
}

function payload(out: Sink, tag: Tag): void {
  switch (tag.type) {
    case "byte":
      out.i8(tag.value);
      return;
    case "short":
      out.i16(tag.value);
      return;
    case "int":
      out.i32(tag.value);
      return;
    case "long":
      out.i64(tag.value);
      return;
    case "float":
      out.f32(tag.value);
      return;
    case "double":
      out.f64(tag.value);
      return;
    case "byteArray":
      out.i32(tag.value.length);
      out.raw(tag.value);
      return;
    case "string":
      text(out, tag.value);
      return;
    case "compound":
      compoundBody(out, tag.value);
      return;
    case "intArray":
      out.i32(tag.value.length);
      for (const v of tag.value) out.i32(v);
      return;
    case "list": {
      out.u8(IDS[tag.itemType]);
      out.i32(tag.items.length);
      for (const item of tag.items) {
        if (tag.itemType === "compound") compoundBody(out, item as Compound);
        else payload(out, { type: tag.itemType, value: item } as Tag);
      }
      return;
    }
  }
}

// --- Reading ---

class Source {
  readonly view: DataView;
  pos = 0;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  need(n: number): void {
    if (this.pos + n > this.bytes.length) throw new RangeError("Unexpected end of NBT data");
  }
  u8(): number {
    this.need(1);
    return this.view.getUint8(this.pos++);
  }
  i8(): number {
    this.need(1);
    return this.view.getInt8(this.pos++);
  }
  i16(): number {
    this.need(2);
    const v = this.view.getInt16(this.pos);
    this.pos += 2;
    return v;
  }
  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }
  i32(): number {
    this.need(4);
    const v = this.view.getInt32(this.pos);
    this.pos += 4;
    return v;
  }
  i64(): bigint {
    this.need(8);
    const v = this.view.getBigInt64(this.pos);
    this.pos += 8;
    return v;
  }
  f32(): number {
    this.need(4);
    const v = this.view.getFloat32(this.pos);
    this.pos += 4;
    return v;
  }
  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.pos);
    this.pos += 8;
    return v;
  }
  take(n: number): Uint8Array {
    this.need(n);
    const out = this.bytes.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  text(): string {
    return decoder.decode(this.take(this.u16()));
  }
}

/** Reads an uncompressed NBT file: the root compound's name and fields. Throws if malformed. */
export function readNbt(bytes: Uint8Array): { name: string; value: Compound } {
  const src = new Source(bytes);
  const type = src.u8();
  if (type !== IDS.compound) throw new Error("NBT data doesn't start with a compound");
  const name = src.text();
  return { name, value: readCompound(src) };
}

function readCompound(src: Source): Compound {
  const out: Compound = {};
  for (;;) {
    const id = src.u8();
    if (id === IDS.end) return out;
    const name = src.text();
    out[name] = readPayload(src, id);
  }
}

function readPayload(src: Source, id: number): Tag {
  const kind = NAMES[id];
  switch (kind) {
    case "byte":
      return nbt.byte(src.i8());
    case "short":
      return nbt.short(src.i16());
    case "int":
      return nbt.int(src.i32());
    case "long":
      return nbt.long(src.i64());
    case "float":
      return nbt.float(src.f32());
    case "double":
      return nbt.double(src.f64());
    case "byteArray": {
      const n = src.i32();
      if (n < 0) throw new RangeError("Negative NBT array length");
      return nbt.byteArray(src.take(n));
    }
    case "string":
      return nbt.string(src.text());
    case "compound":
      return nbt.compound(readCompound(src));
    case "intArray": {
      const n = src.i32();
      if (n < 0) throw new RangeError("Negative NBT array length");
      const arr = new Int32Array(n);
      for (let i = 0; i < n; i++) arr[i] = src.i32();
      return nbt.intArray(arr);
    }
    case "list": {
      const itemId = src.u8();
      const count = src.i32();
      if (count < 0) throw new RangeError("Negative NBT list length");
      const itemKind = NAMES[itemId];
      const nested = itemKind === "list" || itemKind === "byteArray" || itemKind === "intArray";
      if (itemKind === undefined || (nested && count > 0)) {
        throw new Error(`Unsupported NBT list of type ${itemId}`);
      }
      const items: ListItem[] = [];
      for (let i = 0; i < count; i++) {
        if (itemKind === "compound") items.push(readCompound(src));
        else items.push((readPayload(src, itemId) as { value: number | bigint | string }).value);
      }
      return nbt.list(nested ? "end" : (itemKind as ListItemType), items);
    }
    default:
      throw new Error(`Unknown NBT tag type ${id}`);
  }
}
