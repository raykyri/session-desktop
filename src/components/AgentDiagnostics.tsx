import type { AgentAdapterMetadata } from "../types";
import { agentDiagnosticRows } from "../lib/agentSetup";

/** The last check's facts about an agent (where it runs, the executable
 * Session launches, its version, the check time and the reported problem)
 * in a collapsed disclosure. Fields the check did not report are left out. */
export default function AgentDiagnostics({ adapter }: { adapter: AgentAdapterMetadata }) {
  const rows = agentDiagnosticRows(adapter);
  return (
    <details className="agent-setup-details">
      <summary>Details</summary>
      <dl>
        {rows.map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
