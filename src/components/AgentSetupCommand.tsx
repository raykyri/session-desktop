import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { writeClipboardText } from "../lib/clipboard";

/** A shell command with a copy button. Long commands wrap. */
export default function AgentSetupCommand({
  command,
  onCopied,
  onError,
}: {
  command: string;
  onCopied: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="agent-setup-command">
      <code>{command}</code>
      <button
        type="button"
        className="agent-setup-copy"
        aria-label="Copy command"
        title="Copy command"
        onClick={() => {
          void writeClipboardText(command)
            .then(() => {
              onCopied("Command copied");
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            })
            .catch((err) => {
              onError(err instanceof Error ? err.message : String(err));
            });
        }}
      >
        {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
      </button>
    </div>
  );
}
