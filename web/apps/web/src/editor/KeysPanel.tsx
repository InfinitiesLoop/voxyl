import { Fragment, useEffect, useState, useSyncExternalStore } from "react";
import { keySections } from "./keybindings.ts";
import {
  anyCustomized,
  isCustomized,
  isReserved,
  type KeyAction,
  keyLabel,
  keymapVersion,
  resetKeys,
  setKey,
  subscribeKeymap,
} from "./keymap.ts";
import type { EditorTool } from "./tool.ts";

/** What the panel is waiting for: the next key press, for one slot of one action. */
interface Capture {
  readonly id: KeyAction;
  readonly slot: "binding" | "alternate";
}

/**
 * Every key and button, by what it is for: the usual binding, and an alternate. The section
 * for the tool in hand is marked. Opened from Keys in the top bar. "Rebind" lets any keyboard
 * key be changed (click a key, press the new one); it is remembered in this browser.
 */
export function KeysPanel({ tool, onClose }: { tool: EditorTool; onClose: () => void }) {
  useSyncExternalStore(subscribeKeymap, keymapVersion);
  const [rebinding, setRebinding] = useState(false);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (capture === null) {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
        return;
      }
      // Waiting for a key: it is the new binding, and nothing else sees it.
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") {
        setCapture(null);
        setNote(null);
        return;
      }
      if (/^(Control|Alt|Shift|Meta)/.test(e.code) && e.repeat) return;
      if (isReserved(e.code)) {
        setNote(`${keyLabel(e.code)} can't be rebound: it lets go of the pointer.`);
        return;
      }
      if (e.code === "Backspace" && capture.slot === "alternate") {
        setKey(capture.id, "alternate", null);
        setCapture(null);
        setNote("Alternate cleared.");
        return;
      }
      const shared = setKey(capture.id, capture.slot, e.code);
      setCapture(null);
      setNote(
        shared.length > 0
          ? `${keyLabel(e.code)} is also used for ${shared.join(", ")}: fine where they apply in different places.`
          : null,
      );
    };
    // Capture phase, so the editor's own handlers never see the key being chosen.
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [capture, onClose]);

  const sections = keySections();
  return (
    <div className="keys">
      <button type="button" className="keys-backdrop" aria-label="Close keys" onClick={onClose} />
      <div className="keys-card" role="dialog" aria-label="Keys">
        <header>
          <strong>Keys</strong>
          <span>
            {capture
              ? "Press the new key (Esc cancels; Backspace clears an alternate)…"
              : "Most actions have an alternate key, so either hand can reach them."}
          </span>
          <button
            type="button"
            aria-pressed={rebinding}
            title="Click a key to change it"
            onClick={() => {
              setRebinding(!rebinding);
              setCapture(null);
              setNote(null);
            }}
          >
            Rebind
          </button>
          {rebinding && anyCustomized() && (
            <button type="button" onClick={() => resetKeys()}>
              Reset all
            </button>
          )}
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>
        {note && <p className="keys-note-line">{note}</p>}
        <div className="keys-sections">
          {sections.map((section) => {
            const inHand = section.tools?.includes(tool) ?? false;
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
                  <span className="keys-head">Binding</span>
                  <span className="keys-head">Alternate</span>
                  {section.bindings.map((binding) => (
                    <Fragment key={binding.action}>
                      <span className="keys-action">
                        {binding.action}
                        {binding.note && <small className="keys-note">{binding.note}</small>}
                        {rebinding && binding.id && isCustomized(binding.id) && (
                          <button
                            type="button"
                            className="keys-reset"
                            title="Back to the default keys"
                            onClick={() => binding.id && resetKeys(binding.id)}
                          >
                            Reset
                          </button>
                        )}
                      </span>
                      <Slot
                        keys={binding.binding}
                        editable={rebinding && binding.id !== undefined}
                        waiting={capture?.id === binding.id && capture?.slot === "binding"}
                        onPick={() => binding.id && setCapture({ id: binding.id, slot: "binding" })}
                      />
                      <Slot
                        keys={binding.alternate}
                        editable={rebinding && binding.id !== undefined}
                        waiting={capture?.id === binding.id && capture?.slot === "alternate"}
                        onPick={() =>
                          binding.id && setCapture({ id: binding.id, slot: "alternate" })
                        }
                      />
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

function Slot({
  keys,
  editable,
  waiting,
  onPick,
}: {
  keys: readonly string[];
  editable: boolean;
  waiting: boolean;
  onPick: () => void;
}) {
  if (!editable) {
    return (
      <span className="keys-keys">
        {keys.map((key) => (
          <kbd key={key}>{key}</kbd>
        ))}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={waiting ? "keys-keys keys-slot waiting" : "keys-keys keys-slot"}
      title="Click, then press the new key"
      onClick={onPick}
    >
      {waiting ? (
        <kbd>press a key…</kbd>
      ) : keys.length === 0 ? (
        <kbd>none</kbd>
      ) : (
        keys.map((key) => <kbd key={key}>{key}</kbd>)
      )}
    </button>
  );
}
