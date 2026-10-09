import { useEffect } from "react";
import { createPortal } from "react-dom";
import { type NoteTarget, parseNote } from "./note.ts";

/** The project's opening note: a short panel, with links to a home tab or a sample. */
export function NotePanel({
  note,
  onClose,
  onGo,
}: {
  note: string;
  onClose: () => void;
  onGo: (target: NoteTarget) => void;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [onClose]);

  return createPortal(
    <div className="keys note-layer">
      <button type="button" className="keys-backdrop" aria-label="Close" onClick={onClose} />
      <div className="keys-card note-card" role="dialog" aria-label="Note">
        <div className="note-body">
          {parseNote(note).map((paragraph, i) => (
            // Paragraphs have no identity but their order; the note is static while the panel is up.
            // biome-ignore lint/suspicious/noArrayIndexKey: the note does not reorder
            <p key={i}>
              {paragraph.map((span, k) =>
                span.kind === "text" ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: spans stay in written order
                  <span key={k}>{span.text}</span>
                ) : (
                  <button
                    // biome-ignore lint/suspicious/noArrayIndexKey: spans stay in written order
                    key={k}
                    type="button"
                    className="note-link"
                    onClick={() => span.target && onGo(span.target)}
                  >
                    {span.label}
                  </button>
                ),
              )}
            </p>
          ))}
        </div>
        <div className="note-actions">
          <button type="button" className="primary" onClick={onClose}>
            OK
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
