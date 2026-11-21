// A reply's or comment's text (02 §4.3, the mock's `fmtReply`): lines that
// start with "> " are quotes, and `@handle` of a member of the channel is a
// mention.

import { memberKey } from "@session/mutators";

import { useReplicaQuery } from "../../replica/ReplicaProvider.js";
import type { ChannelView } from "../../replica/queries.js";
import { UNKNOWN } from "../../replica/source.js";
import { MENTION, formatReply, type ReplyInline } from "../feed/format.js";

function Inline({ parts }: { parts: ReplyInline[] }) {
  return (
    <>
      {parts.map((part, i) =>
        part.mention ? (
          <span key={i} className="mention">
            {part.text}
          </span>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

export function ReplyText({ text, channel }: { text: string; channel: ChannelView | null }) {
  const handles = [...text.matchAll(MENTION)].map((m) => (m[1] ?? "").replace(/\.$/, ""));
  const members = useReplicaQuery(
    (source) =>
      channel ? handles.filter((h) => source.get(memberKey(channel.id, h))?.kind === "member") : [],
    [channel?.id, handles.join(",")],
  );
  const known = new Set(members === UNKNOWN ? [] : members);
  const parts = formatReply(text, (h) => known.has(h));
  return (
    <div className="rtext">
      {parts.map((part, i) =>
        part.kind === "quote" ? (
          <blockquote key={i}>
            {part.lines.map((line, j) => (
              <span key={j}>
                {j > 0 ? <br /> : null}
                <Inline parts={line} />
              </span>
            ))}
          </blockquote>
        ) : (
          <p key={i}>
            <Inline parts={part.inline} />
          </p>
        ),
      )}
    </div>
  );
}
