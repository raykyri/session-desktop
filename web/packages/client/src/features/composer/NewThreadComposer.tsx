// The new-thread composer (02 §5, W5.1; the mock's `COMPOSERS.split` with
// `nb-a btn-faded`): the member's 20 px avatar at its start, centred on the
// text's first line; the growing field ("Ask anything" / "Write a post",
// 15 px, label "Ask or post"); the channel picker on Home and Saved (the
// channel's name as static text on a channel); the model picker for asks,
// with its Effort submenu; and the split send button, whose main part sends
// and whose chevron chooses Ask or Post. ⌘↵ (Ctrl↵ elsewhere) sends; Enter
// is a newline. Signed out it is a disabled cover that opens sign-in.

import { Menu } from "@base-ui/react/menu";
import { useNavigate } from "@tanstack/react-router";
import type { MouseEvent, RefObject } from "react";
import { useEffect, useRef, useState } from "react";

import { useOnlineData } from "../../replica/ReplicaProvider.js";
import {
  composerModel,
  effortLabel,
  keyOnlyProvider,
  stepDownEffort,
  type Effort,
  type KeyProvider,
  type ModelOption,
} from "../../replica/online.js";
import type { ChannelView } from "../../replica/queries.js";
import { useWrites } from "../../replica/writes.js";
import { useDraftsStore } from "../../stores/drafts.js";
import { Avatar, ChannelGlyph } from "../../ui/Avatar.js";
import { useComposerChoice, useFeedViewer } from "../feed/FeedContext.js";
import { CheckMark, ChevronDown, ChevronRight, PencilIcon, SendArrowIcon } from "../feed/icons.js";
import { SHELL_MENU_ITEM, SHELL_MENU_POPUP, SHELL_MENU_SEPARATOR } from "../shell/menuStyles.js";

import { growField, isSendChord } from "./InlineComposer.js";

export const NEW_THREAD_DRAFT = "new";

export type Mode = "ask" | "post";

const MENU_POPUP = `${SHELL_MENU_POPUP} fpop-menu`;

function useNarrow(width: number): boolean {
  const query = `(max-width: ${width}px)`;
  const get = () => typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [narrow, setNarrow] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const on = () => setNarrow(list.matches);
    list.addEventListener("change", on);
    return () => list.removeEventListener("change", on);
  }, [query]);
  return narrow;
}

/** The channel picker (title "Channel"): the joined channels as radio items. */
function ChannelPicker({
  channels,
  value,
  onChange,
  field,
}: {
  channels: readonly ChannelView[];
  value: ChannelView | undefined;
  onChange: (id: string) => void;
  field: RefObject<HTMLTextAreaElement | null>;
}) {
  const narrow = useNarrow(600);
  return (
    <Menu.Root>
      <Menu.Trigger className="pick" title="Channel">
        <span>#{value?.name ?? ""}</span>
        <ChevronDown />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          side="bottom"
          align={narrow ? "end" : "start"}
          sideOffset={6}
          className="z-(--z-popover)"
        >
          <Menu.Popup
            className={`${MENU_POPUP} max-h-[min(460px,62vh)] min-w-[210px] overflow-y-auto p-1.5`}
            finalFocus={field}
            aria-label="Channel"
          >
            <Menu.RadioGroup
              value={value?.id ?? ""}
              onValueChange={(id: unknown) => onChange(id as string)}
            >
              {channels.map((c) => (
                <Menu.RadioItem
                  closeOnClick
                  key={c.id}
                  value={c.id}
                  className={`${SHELL_MENU_ITEM} h-8 gap-2.5`}
                >
                  <ChannelGlyph name={c.name} />
                  <span className="flex-1">#{c.name}</span>
                  <Menu.RadioItemIndicator className="text-accent inline-flex">
                    <CheckMark />
                  </Menu.RadioItemIndicator>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** The model picker (title "Model and effort"): short names on the button,
 * full names in the menu, then Effort with a submenu of the efforts the
 * chosen model accepts. Choosing a model that does not accept the effort
 * steps the effort down (02 §5). */
export function ModelPicker({
  models,
  model,
  effort,
  keys = [],
  onChange,
  field,
}: {
  models: readonly ModelOption[];
  model: ModelOption;
  effort: Effort;
  /** The providers the member has a valid key for (03 K11). */
  keys?: readonly KeyProvider[];
  onChange: (choice: { model: string; effort: Effort }) => void;
  field: RefObject<HTMLTextAreaElement | null>;
}) {
  const narrow = useNarrow(600);
  const navigate = useNavigate();
  return (
    <Menu.Root>
      <Menu.Trigger className="pick" title="Model and effort">
        <span>{model.short}</span>
        <ChevronDown />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          side="bottom"
          align={narrow ? "end" : "start"}
          sideOffset={6}
          className="z-(--z-popover)"
        >
          <Menu.Popup
            className={`${MENU_POPUP} max-w-[calc(100vw-40px)]`}
            finalFocus={field}
            aria-label="Model"
          >
            <Menu.RadioGroup
              value={model.id}
              onValueChange={(id: unknown) => {
                const next = models.find((m) => m.id === id);
                if (next)
                  onChange({ model: next.id, effort: stepDownEffort(effort, next.efforts) });
              }}
            >
              {models.map((m) => {
                // A key-only model (03 K11): without its key, a row that
                // opens Usage to add one; with it, the key it runs on.
                const keyOnly = keyOnlyProvider(m);
                if (keyOnly !== null && !keys.includes(keyOnly)) {
                  return (
                    <Menu.Item
                      key={m.id}
                      className={SHELL_MENU_ITEM}
                      onClick={() => void navigate({ to: "/usage" })}
                    >
                      <span className="flex-1">
                        {m.label}
                        <span className="mi-src">Add a key</span>
                      </span>
                    </Menu.Item>
                  );
                }
                return (
                  <Menu.RadioItem closeOnClick key={m.id} value={m.id} className={SHELL_MENU_ITEM}>
                    <span className="flex-1">
                      {m.label}
                      {keyOnly !== null ? (
                        <span className="mi-src">
                          your {keyOnly === "openai" ? "OpenAI" : "Anthropic"} key
                        </span>
                      ) : null}
                    </span>
                    <Menu.RadioItemIndicator className="text-accent inline-flex">
                      <CheckMark />
                    </Menu.RadioItemIndicator>
                  </Menu.RadioItem>
                );
              })}
            </Menu.RadioGroup>
            <div className={SHELL_MENU_SEPARATOR} />
            <Menu.SubmenuRoot>
              <Menu.SubmenuTrigger className={SHELL_MENU_ITEM}>
                <span className="flex-1">Effort</span>
                <span className="mi-v">{effortLabel(effort)}</span>
                <span className="text-fg-muted inline-flex">
                  <ChevronRight />
                </span>
              </Menu.SubmenuTrigger>
              <Menu.Portal>
                <Menu.Positioner
                  side={narrow ? "bottom" : "right"}
                  align={narrow ? "end" : "start"}
                  sideOffset={4}
                  alignOffset={narrow ? 0 : -4}
                  className="z-(--z-popover)"
                >
                  <Menu.Popup
                    className={`${MENU_POPUP} min-w-[140px]`}
                    finalFocus={field}
                    aria-label="Effort"
                  >
                    <Menu.RadioGroup
                      value={effort}
                      onValueChange={(value: unknown) =>
                        onChange({ model: model.id, effort: value as Effort })
                      }
                    >
                      {model.efforts.map((e) => (
                        <Menu.RadioItem closeOnClick key={e} value={e} className={SHELL_MENU_ITEM}>
                          <span className="flex-1">{effortLabel(e)}</span>
                          <Menu.RadioItemIndicator className="text-accent inline-flex">
                            <CheckMark />
                          </Menu.RadioItemIndicator>
                        </Menu.RadioItem>
                      ))}
                    </Menu.RadioGroup>
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.SubmenuRoot>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** The split send button: the send arrow in both modes ("Ask" or "Post"),
 * disabled while the field is empty; the chevron ("Ask or post") opens the
 * mode menu. */
function SendSplitButton({
  mode,
  empty,
  onMode,
  field,
}: {
  mode: Mode;
  empty: boolean;
  onMode: (mode: Mode) => void;
  field: RefObject<HTMLTextAreaElement | null>;
}) {
  const label = mode === "ask" ? "Ask" : "Post";
  return (
    <span className="split">
      <button
        type="submit"
        className="split-main"
        disabled={empty}
        aria-label={label}
        title={label}
      >
        <SendArrowIcon />
      </button>
      <Menu.Root>
        <Menu.Trigger className="split-more" aria-label="Ask or post">
          <ChevronDown />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-(--z-popover)">
            <Menu.Popup className={MENU_POPUP} finalFocus={field}>
              <Menu.RadioGroup
                value={mode}
                onValueChange={(value: unknown) => onMode(value as Mode)}
              >
                {(
                  [
                    ["ask", "Ask", "Agent researches and answers", <SendArrowIcon key="a" />],
                    ["post", "Post", "A message to people in the channel", <PencilIcon key="p" />],
                  ] as const
                ).map(([value, title, sub, icon]) => (
                  <Menu.RadioItem
                    closeOnClick
                    key={value}
                    value={value}
                    className={`${SHELL_MENU_ITEM} mi-2 h-auto items-start`}
                  >
                    <span className="text-fg-muted inline-grid h-[18px] w-4 flex-none place-items-center">
                      {icon}
                    </span>
                    <span className="flex-1">
                      <b>{title}</b>
                      <small>{sub}</small>
                    </span>
                    <Menu.RadioItemIndicator className="text-accent mt-[3px] inline-flex">
                      <CheckMark />
                    </Menu.RadioItemIndicator>
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </span>
  );
}

export interface NewThreadComposerProps {
  /** The channel of a channel feed; null on Home and Saved (the picker). */
  channel: ChannelView | null;
  /** The viewer's channels, for the picker. */
  joined: readonly ChannelView[];
  /** A new thread was written: its id. */
  onCreated?: (id: string) => void;
}

export function NewThreadComposer({ channel, joined, onCreated }: NewThreadComposerProps) {
  const { me, signedOut, signIn } = useFeedViewer();
  const online = useOnlineData();
  const chosen = useComposerChoice();
  const writes = useWrites();
  const field = useRef<HTMLTextAreaElement>(null);
  const text = useDraftsStore((state) =>
    state.hidden ? "" : (state.byKey[NEW_THREAD_DRAFT]?.text ?? ""),
  );
  const setDraft = useDraftsStore((state) => state.setDraft);
  const clearDraft = useDraftsStore((state) => state.clearDraft);
  const [mode, setMode] = useState<Mode>("ask");
  const [space, setSpace] = useState<string | null>(null);

  const model = composerModel(online, chosen.model);
  const effort = model
    ? stepDownEffort(chosen.effort ?? online.defaultEffort, model.efforts)
    : "low";
  const target = channel ?? joined.find((c) => c.id === space) ?? joined[0];

  useEffect(() => {
    if (field.current && text) growField(field.current);
    // Only when the composer mounts with a draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const empty = !text.trim();
  const placeholder = signedOut
    ? "Sign in to ask or post"
    : mode === "ask"
      ? "Ask anything"
      : "Write a post";

  const send = async () => {
    const q = text.trim();
    if (!q || !target) {
      field.current?.focus();
      return;
    }
    const id =
      mode === "ask" && model
        ? await writes.ask(target.id, q, model.id, effort)
        : await writes.post(target.id, q);
    if (id) {
      clearDraft(NEW_THREAD_DRAFT);
      if (field.current) field.current.style.height = "";
      onCreated?.(id);
    }
  };

  // A pointer-down on the composer outside its controls keeps the caret in
  // the field (the mock's mousedown handler).
  const keepCaret = (event: MouseEvent) => {
    const target_ = event.target as HTMLElement;
    if (target_.closest("textarea, button, [role='menu']")) return;
    event.preventDefault();
    const el = field.current;
    if (el && document.activeElement !== el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  };

  const form = (
    // The pointer-down only keeps the caret in the field; every control in
    // the form is reachable from the keyboard.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <form
      className={`nb${empty ? "" : "has-text"}`}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
      onMouseDown={keepCaret}
    >
      <span className="nb-av inline-flex">
        {me ? (
          <Avatar handle={me} size="sm" />
        ) : (
          <span aria-hidden="true" className="bg-control inline-block size-5 rounded-full" />
        )}
      </span>
      <textarea
        ref={field}
        rows={1}
        placeholder={placeholder}
        aria-label="Ask or post"
        value={text}
        onChange={(event) => {
          setDraft(NEW_THREAD_DRAFT, event.target.value);
          growField(event.target);
        }}
        onKeyDown={(event) => {
          if (isSendChord(event)) {
            event.preventDefault();
            void send();
          }
        }}
      />
      {channel ? (
        <span className="pick static">#{channel.name}</span>
      ) : (
        <ChannelPicker channels={joined} value={target} onChange={setSpace} field={field} />
      )}
      {mode === "ask" && model ? (
        <ModelPicker
          models={online.models}
          model={model}
          effort={effort}
          keys={online.keys}
          onChange={(next) => chosen.set(next)}
          field={field}
        />
      ) : null}
      <SendSplitButton
        mode={mode}
        empty={empty}
        onMode={(next) => {
          setMode(next);
          requestAnimationFrame(() => {
            const el = field.current;
            el?.focus();
            el?.setSelectionRange(el.value.length, el.value.length);
          });
        }}
        field={field}
      />
    </form>
  );

  if (signedOut)
    return (
      <div className="nb-offw">
        <fieldset className="nb-off" disabled aria-hidden="true">
          {form}
        </fieldset>
        <button
          type="button"
          className="nb-cover"
          aria-label="Sign in to ask or post"
          onClick={signIn}
        />
      </div>
    );
  return form;
}
