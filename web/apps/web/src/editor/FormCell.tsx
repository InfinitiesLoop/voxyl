import type { Form } from "@voxyl/core";
import { PLACEMENT_CHOICES, placementName, placementOf } from "../world/editing.ts";
import { ShapePicker } from "./ShapePicker.tsx";

/**
 * A semantic's form in a table row: the shape it places, or, for whole blocks, how they turn.
 * An empty form (undefined) means whole blocks placed as the block they look like is.
 */
export function FormCell({
  form,
  onChange,
}: {
  form: Form | undefined;
  onChange: (form: Form | undefined) => void;
}) {
  const shape = form?.shape ?? null;
  const placement = placementName(form?.placement);
  const set = (next: Form) => onChange(Object.keys(next).length > 0 ? next : undefined);
  return (
    <div className="form-cell">
      <ShapePicker
        shape={shape}
        onChange={(next) =>
          set(next ? { shape: next } : { ...(form?.placement && { placement: form.placement }) })
        }
      />
      {shape === null && (
        <select
          aria-label="Placing"
          title="How whole blocks of this turn when placed. By default, as the block it looks like does."
          value={placement}
          onChange={(e) => {
            const profile = placementOf(e.target.value);
            set(profile ? { placement: profile } : {});
          }}
        >
          {PLACEMENT_CHOICES.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
            </option>
          ))}
          {placement === "custom" && <option value="custom">Custom</option>}
        </select>
      )}
    </div>
  );
}
