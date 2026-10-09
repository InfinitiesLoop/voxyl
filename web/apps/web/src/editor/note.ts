import { sampleKind, type WorldKind } from "../worlds.ts";

/** A home tab a note can link to. `builds` is the projects tab. */
export type NoteTab = "projects" | "palettes" | "prefabs" | "blocks";

export type NoteTarget = { readonly tab: NoteTab } | { readonly sample: WorldKind };

export type NoteSpan =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "link";
      readonly label: string;
      readonly href: string;
      readonly target: NoteTarget | null;
    };

/** Paragraphs of text and `[label](target)` links. Anything that isn't a voxyl target stays text. */
export function parseNote(source: string): readonly (readonly NoteSpan[])[] {
  return source
    .replaceAll("\r\n", "\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "")
    .map(parseParagraph);
}

/** `builds`, `palettes`, `prefabs`, `blocks`, or `sample:<kind>`. Anything else is not a link. */
export function noteTarget(href: string): NoteTarget | null {
  if (href === "builds") return { tab: "projects" };
  if (href === "palettes" || href === "prefabs" || href === "blocks") return { tab: href };
  if (href.startsWith("sample:")) {
    const kind = sampleKind(href.slice("sample:".length));
    if (kind) return { sample: kind };
  }
  return null;
}

function parseParagraph(paragraph: string): readonly NoteSpan[] {
  const text = paragraph.replaceAll("\n", " ");
  const spans: NoteSpan[] = [];
  const link = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (const match of text.matchAll(link)) {
    const index = match.index ?? 0;
    if (index > last) spans.push({ kind: "text", text: text.slice(last, index) });
    const href = match[2] ?? "";
    const target = noteTarget(href);
    const piece = match[0];
    if (target) spans.push({ kind: "link", label: match[1] ?? "", href, target });
    else pushText(spans, piece);
    last = index + piece.length;
  }
  if (last < text.length) pushText(spans, text.slice(last));
  return spans;
}

function pushText(spans: NoteSpan[], text: string): void {
  const prev = spans.at(-1);
  if (prev?.kind === "text") spans[spans.length - 1] = { kind: "text", text: prev.text + text };
  else spans.push({ kind: "text", text });
}
