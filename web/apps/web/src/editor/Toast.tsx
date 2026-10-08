import type { Engine } from "../scene/Engine.ts";
import { useStore } from "./useStore.ts";

/** What the editor refused or reports, as one line over the hotbar. It fades by itself. */
export function Toast({ engine }: { engine: Engine }) {
  const toast = useStore(engine.toast);
  if (!toast) return null;
  return (
    <div key={toast.id} className="toast" role="status">
      {toast.text}
    </div>
  );
}
