import { SHAPE_PAGES, shapeName } from "@voxyl/shapes";
import { useEffect, useRef, useState } from "react";
import { ShapeIcon } from "./ShapeIcon.tsx";

/**
 * Which shape a semantic places: whole blocks, a microblock (cover, panel, slab, strip, post,
 * corner, ...) or a roof or slope piece. The shape is intent, so it sits on the semantic and
 * no palette changes it; what material the part is made of is the look's business.
 */
export function ShapePicker({
  shape,
  onChange,
  wholeBlockLocked = false,
  disabled = false,
}: {
  /** The chosen shape's id, or null for whole blocks. */
  shape: string | null;
  onChange: (shape: string | null) => void;
  /** The semantic inherits a shape it can't drop (looks and forms only merge). */
  wholeBlockLocked?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (event.target instanceof Node && root.current?.contains(event.target)) return;
      setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key, true);
    };
  }, [open]);

  const pick = (next: string | null) => {
    onChange(next);
    setOpen(false);
  };

  return (
    <div className="shape-picker" ref={root}>
      <button
        type="button"
        className="shape-current"
        disabled={disabled}
        aria-expanded={open}
        title="The shape this places: whole blocks, or a part"
        onClick={() => setOpen(!open)}
      >
        {shape ? <ShapeIcon shape={shape} /> : <span className="shape-block" aria-hidden />}
        <span>{shape ? shapeName(shape) : "Whole block"}</span>
      </button>
      {open && (
        <div className="shape-pop" role="listbox" aria-label="Shape">
          <button
            type="button"
            role="option"
            aria-selected={shape === null}
            disabled={wholeBlockLocked}
            title={wholeBlockLocked ? "It inherits a shape. Pick another." : "Plain blocks"}
            className="shape-option"
            onClick={() => pick(null)}
          >
            <span className="shape-block" aria-hidden />
            <span>Whole block</span>
          </button>
          {SHAPE_PAGES.map((page) => (
            <section key={page.title}>
              <h4>{page.title}</h4>
              <div className="shape-grid">
                {page.ids.map((id) => (
                  <button
                    key={id}
                    type="button"
                    role="option"
                    aria-selected={id === shape}
                    className="shape-option"
                    title={shapeName(id)}
                    onClick={() => pick(id)}
                  >
                    <ShapeIcon shape={id} />
                    <span>{shapeName(id)}</span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
