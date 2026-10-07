import { Fragment, useEffect } from "react";
import { KEY_SECTIONS } from "./keybindings.ts";
import type { EditorTool } from "./tool.ts";

/**
 * Every key and button, by what it is for, with the right-hand keys in their own column.
 * The section for the tool in hand is marked. Opened from Keys in the top bar.
 */
export function KeysPanel({ tool, onClose }: { tool: EditorTool; onClose: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);

  return (
    <div className="keys">
      <button type="button" className="keys-backdrop" aria-label="Close keys" onClick={onClose} />
      <div className="keys-card" role="dialog" aria-label="Keys">
        <header>
          <strong>Keys</strong>
          <span>
            Every action has a key for the right hand, for flying with the mouse in the left.
          </span>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="keys-sections">
          {KEY_SECTIONS.map((section) => {
            const inHand = section.tool === tool;
            return (
              <section
                key={section.id}
                className={inHand ? "keys-section in-hand" : "keys-section"}
              >
                <h3>
                  {section.title}
                  <small>{inHand ? "the tool in hand" : section.when}</small>
                </h3>
                <div className="keys-table">
                  <span className="keys-head">Action</span>
                  <span className="keys-head">Keys</span>
                  <span className="keys-head">Right hand</span>
                  {section.bindings.map((binding) => (
                    <Fragment key={binding.action}>
                      <span className="keys-action">
                        {binding.action}
                        {binding.note && <small className="keys-note">{binding.note}</small>}
                      </span>
                      <Keys keys={binding.keys} />
                      <Keys keys={binding.right ?? []} />
                    </Fragment>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Keys({ keys }: { keys: readonly string[] }) {
  return (
    <span className="keys-keys">
      {keys.map((key) => (
        <kbd key={key}>{key}</kbd>
      ))}
    </span>
  );
}
