import { useCallback, useMemo, useState } from "react";
import { buildDemoWorld, DEMO_PALETTE } from "./demo.ts";
import { type Backend, Viewport } from "./Viewport.tsx";

export function App() {
  const world = useMemo(buildDemoWorld, []);
  const [backend, setBackend] = useState<Backend | null>(null);
  const onReady = useCallback((b: Backend) => setBackend(b), []);

  return (
    <div className="app">
      <Viewport world={world} palette={DEMO_PALETTE} onReady={onReady} />
      <header className="hud">
        <strong>Voxyl</strong>
        <span>{world.cellCount.toLocaleString()} cells</span>
        <span>{backend ?? "starting renderer"}</span>
      </header>
    </div>
  );
}
