import test from "ava";

import {
  stripTaggedInstructionBlocks,
  stripTaggedInstructionBlocksForPreview,
  stripTaggedUserInstructionBlocks,
  taggedUserInstructionDetails,
} from "../src/app/taggedInstructions.js";

test("removes embedded tagged instruction blocks from copied user messages", (t) => {
  const message = [
    "Please fix the copy action.",
    "",
    "<system-reminder>",
    "Do not include this injected instruction.",
    "</system-reminder>",
    "",
    "Keep this second paragraph.",
  ].join("\n");

  const copied = stripTaggedUserInstructionBlocks(message);

  t.is(copied.includes("<system-reminder>"), false);
  t.is(copied.includes("Do not include this injected instruction."), false);
  t.is(copied.includes("Please fix the copy action."), true);
  t.is(copied.includes("Keep this second paragraph."), true);
});

test("removes nested and consecutive tagged instruction blocks", (t) => {
  const message = [
    "<environment_context>",
    "<cwd>/private/project</cwd>",
    "</environment_context>",
    "<permissions>",
    "secret policy",
    "</permissions>",
    "User-authored message",
  ].join("\n");

  t.is(stripTaggedUserInstructionBlocks(message), "\nUser-authored message");
});

test("removes the attributed session agent-driver instruction block", (t) => {
  const message = [
    '<session_instruction source="agent_driver">',
    "Do not change the working tree or codebase unless explicitly instructed to.",
    "</session_instruction>",
    "Inspect the failing request.",
  ].join("\n");

  t.is(stripTaggedUserInstructionBlocks(message), "\nInspect the failing request.");
});

test("does not treat arbitrary attributed XML blocks as injected instructions", (t) => {
  const message = ['<note source="user">', "Keep this content.", "</note>"].join("\n");

  t.is(stripTaggedUserInstructionBlocks(message), message);
});

test("preserves inline tag examples that are part of user-authored prose", (t) => {
  const message = "Explain how <strong>important</strong> is rendered.";

  t.is(stripTaggedUserInstructionBlocks(message), message);
});

test("user-message stripping preserves fenced and indented code", (t) => {
  const message = [
    "Please review this hook file:",
    "",
    "```xml",
    "<system-reminder>",
    "Literal fenced XML the user pasted.",
    "</system-reminder>",
    "```",
    "",
    "    <config>",
    "    Literal indented XML.",
    "    </config>",
    "",
    "<system-reminder>",
    "Actually injected instructions.",
    "</system-reminder>",
    "",
    "What does it do?",
  ].join("\n");

  const copied = stripTaggedUserInstructionBlocks(message);

  t.is(copied.includes("Literal fenced XML the user pasted."), true);
  t.is(copied.includes("Literal indented XML."), true);
  t.is(copied.includes("Actually injected instructions."), false);
  t.is(copied.includes("What does it do?"), true);
});

test("preview stripping drops indented slash-command marker blocks", (t) => {
  const message = [
    "<command-message>copy</command-message>",
    "        <command-args></command-args>",
  ].join("\n");

  t.is(stripTaggedInstructionBlocksForPreview(message).trim(), "");
});

test("preview stripping keeps real prose after a marker block", (t) => {
  const message = [
    "<command-name>run</command-name>",
    "        <command-args>--fast</command-args>",
    "Deploy the staging build.",
  ].join("\n");

  t.is(stripTaggedInstructionBlocksForPreview(message).trim(), "Deploy the staging build.");
});

test("generic tagged-block stripping preserves preceding Markdown headings", (t) => {
  const message = [
    "# Visible answer",
    "",
    "<system-reminder>",
    "Hidden instructions.",
    "</system-reminder>",
    "",
    "Keep this conclusion.",
  ].join("\n");

  t.is(stripTaggedInstructionBlocks(message), "# Visible answer\n\n\n\nKeep this conclusion.");
});

test("generic tagged-block stripping preserves fenced and indented code", (t) => {
  const message = [
    "Examples:",
    "",
    "```xml",
    "<system-reminder>",
    "Literal fenced XML.",
    "</system-reminder>",
    "```",
    "",
    "    <user-instructions>",
    "    Literal indented XML.",
    "    </user-instructions>",
    "",
    "<system-reminder>",
    "Hidden instructions.",
    "</system-reminder>",
    "",
    "Visible conclusion.",
  ].join("\n");

  t.is(
    stripTaggedInstructionBlocks(message),
    [
      "Examples:",
      "",
      "```xml",
      "<system-reminder>",
      "Literal fenced XML.",
      "</system-reminder>",
      "```",
      "",
      "    <user-instructions>",
      "    Literal indented XML.",
      "    </user-instructions>",
      "",
      "",
      "",
      "Visible conclusion.",
    ].join("\n"),
  );
});

// The runtime wraps the custom research launch instruction (the settings
// dialog's "Research instructions" text) in a <research-instructions> tagged
// block — leading normally, trailing when the prompt begins with a slash
// command. Both forms must strip back to the user's own words in the
// user-message display/copy path and in previews, like any other
// session-injected instruction block.
test("strips the research launch instruction block the runtime prepends", (t) => {
  const sent = [
    "<research-instructions>",
    "Answer concisely, in a few short paragraphs.",
    "</research-instructions>",
    "",
    "Why is the sky blue?",
  ].join("\n");

  t.is(stripTaggedUserInstructionBlocks(sent).trim(), "Why is the sky blue?");
  t.is(stripTaggedInstructionBlocksForPreview(sent).trim(), "Why is the sky blue?");
});

test("strips the research launch instruction block appended after slash commands", (t) => {
  const sent = [
    "/deep-research Why is the sky blue?",
    "",
    "<research-instructions>",
    "Answer concisely.",
    "</research-instructions>",
  ].join("\n");

  t.is(stripTaggedUserInstructionBlocks(sent).trim(), "/deep-research Why is the sky blue?");
  t.is(stripTaggedInstructionBlocksForPreview(sent).trim(), "/deep-research Why is the sky blue?");
});

test("unwraps timestamp and user_query envelopes as the prompt", (t) => {
  const message = [
    "<timestamp>Wednesday, Aug 19, 2026, 3:52 PM (UTC-4)</timestamp>",
    "<user_query>",
    "can you cherry pick those 7 commits onto HEAD, except 3b22fc07",
    "</user_query>",
  ].join("\n");

  t.is(taggedUserInstructionDetails(message), null);
  t.is(
    stripTaggedUserInstructionBlocks(message).trim(),
    "can you cherry pick those 7 commits onto HEAD, except 3b22fc07",
  );
  t.is(
    stripTaggedInstructionBlocksForPreview(message).trim(),
    "can you cherry pick those 7 commits onto HEAD, except 3b22fc07",
  );
});

test("preserves image markers around a user_query envelope", (t) => {
  const message = [
    "[Image]",
    "<timestamp>Wednesday, Aug 19, 2026, 4:25 PM (UTC-4)</timestamp>",
    "<user_query>",
    "transcripts seem to not have user messages, they're mistakenly collapsed: [Image #1]",
    "</user_query>",
  ].join("\n");

  const copied = stripTaggedUserInstructionBlocks(message);
  t.is(taggedUserInstructionDetails(message), null);
  t.is(copied.includes("[Image]"), true);
  t.is(copied.includes("[Image #1]"), true);
  t.is(copied.includes("mistakenly collapsed"), true);
  t.is(copied.includes("<timestamp>"), false);
  t.is(copied.includes("<user_query>"), false);
});

test("reports the tag sequence of a fully tagged instruction message", (t) => {
  const message = [
    "<environment_context>",
    "<cwd>/private/project</cwd>",
    "</environment_context>",
    "<permissions>",
    "secret policy",
    "</permissions>",
  ].join("\n");

  t.deepEqual(taggedUserInstructionDetails(message), {
    label: "<environment_context> <permissions>",
    tags: ["environment_context", "permissions"],
  });
});
