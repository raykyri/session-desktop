// The account's usage today (web only; opened from the account menu).
// `usage.summary` is one UTC day of totals against the account's limits; it
// has no per-model dimension, so this is a totals table.

import { useUsage } from "../../api/queries.js";
import { ControlButton } from "../../ui/Button.js";
import { Dialog } from "../../ui/Dialog.js";
import { QueryState } from "../../ui/QueryState.js";

function tokenRow(label: string, value: number) {
  return { label, value: value.toLocaleString() };
}

export function UsageTable() {
  const usage = useUsage();
  const summary = usage.data;
  if (!summary) {
    return (
      <QueryState
        className="py-0"
        loading={usage.isLoading}
        loadingLabel="Loading usage…"
        error={usage.isError ? "Couldn’t load usage." : undefined}
        onRetry={() => void usage.refetch()}
        empty="No usage recorded."
      />
    );
  }
  const rows = [
    tokenRow("Input tokens", summary.inputTokens),
    tokenRow("Output tokens", summary.outputTokens),
    tokenRow("Reasoning tokens", summary.reasoningTokens),
    tokenRow("Cached tokens", summary.cachedTokens),
    tokenRow("Runs", summary.runs),
    { label: "Estimated cost", value: `$${(summary.costEstimateMicros / 1_000_000).toFixed(2)}` },
    {
      label: "Daily token limit",
      value: summary.dailyTokenLimit == null ? "none" : summary.dailyTokenLimit.toLocaleString(),
    },
    {
      label: "Daily run limit",
      value: summary.dailyRunLimit == null ? "none" : summary.dailyRunLimit.toLocaleString(),
    },
  ];
  return (
    <table className="w-full border-collapse text-base">
      <caption className="text-fg-muted pb-2 text-left text-base">
        {new Date(summary.day).toISOString().slice(0, 10)}, UTC
      </caption>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label} className="border-border-divider border-t">
            <th scope="row" className="text-fg-secondary py-1.5 text-left font-normal">
              {row.label}
            </th>
            <td className="py-1.5 text-right tabular-nums">{row.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function UsageDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Usage"
      footer={<ControlButton onClick={() => onOpenChange(false)}>Close</ControlButton>}
    >
      {open ? <UsageTable /> : null}
    </Dialog>
  );
}
