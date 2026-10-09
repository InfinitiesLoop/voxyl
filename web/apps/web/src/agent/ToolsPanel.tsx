// The dev panel's Tools section: pick an agent tool, edit its JSON arguments, run it and read
// the envelope. It calls through the same ToolClient as WebMCP, so what you see is what an
// agent gets (including "Claude: <tool>" in the undo history).

import type { ToolListing } from "@voxyl/tools";
import { useEffect, useState } from "react";
import type { ToolClient } from "./webmcp.ts";

export function ToolsPanel({ client }: { client: ToolClient | null }) {
  const [tools, setTools] = useState<readonly ToolListing[]>([]);
  const [name, setName] = useState("status");
  const [args, setArgs] = useState("{}");
  const [result, setResult] = useState("");
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let live = true;
    client?.tools().then(
      (list) => live && setTools(list),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [client]);

  const run = async () => {
    if (!client) return;
    setRunning(true);
    try {
      setResult(JSON.stringify(await client.call(name, JSON.parse(args || "{}")), null, 2));
    } catch (error) {
      setResult(`Could not run: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRunning(false);
    }
  };

  const current = tools.find((t) => t.name === name);
  return (
    <details className="tools">
      <summary>Tools</summary>
      <select
        aria-label="Tool"
        value={name}
        title={current?.description}
        onChange={(e) => setName(e.target.value)}
      >
        {tools.length === 0 && <option value={name}>{name}</option>}
        {tools.map((t) => (
          <option key={t.name} value={t.name}>
            {t.name}
          </option>
        ))}
      </select>
      <textarea
        aria-label="Arguments (JSON)"
        spellCheck={false}
        rows={4}
        value={args}
        onChange={(e) => setArgs(e.target.value)}
      />
      <button type="button" disabled={!client || running} onClick={() => void run()}>
        Run
      </button>
      {result && <pre>{result}</pre>}
    </details>
  );
}
