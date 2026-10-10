import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { researchMenuKeyTarget } from "./research/ResearchMenu";

export interface LauncherSelectOption {
  value: string;
  label: string;
  iconSrc?: string;
  /** A glyph component, for options without an image icon. */
  icon?: ReactNode;
  iconClassName?: string;
  dividerBefore?: boolean;
  tone?: "danger";
  detail?: string;
  disabled?: boolean;
}

/** A secondary choice shown as one row at the bottom of the popover, below a
 * separator, that opens its own option list beside the row. */
interface LauncherSelectSubmenu {
  label: string;
  value: string;
  options: LauncherSelectOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
}

interface LauncherSelectProps {
  value: string;
  options: LauncherSelectOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
  disabled?: boolean;
  submenu?: LauncherSelectSubmenu;
  /** Controlled open state. Every open and close, including Escape, Tab, a
   * choice and a press outside, goes through `onOpenChange`. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** An element the caller renders to open the menu, instead of the built-in
   * trigger (which is then not rendered). The popover aligns to it, a press on
   * it does not count as a press outside, and focus returns to it when the
   * menu closes from the keyboard or a choice. Use with `open`. */
  anchorRef?: RefObject<HTMLElement | null>;
}

const SUBMENU_GAP = 4;

const toneClass = (tone?: string) => (tone ? ` is-${tone}` : "");
const iconClass = (option?: LauncherSelectOption) =>
  ["launcher-select-icon", option?.iconClassName].filter(Boolean).join(" ");

/** An option's icon: its image, or its glyph. */
export function OptionIcon({ option }: { option?: LauncherSelectOption }) {
  if (option?.iconSrc) {
    return <img className={iconClass(option)} src={option.iconSrc} alt="" aria-hidden="true" />;
  }
  return option?.icon ? (
    <span className={iconClass(option)} aria-hidden="true">
      {option.icon}
    </span>
  ) : null;
}

function enabledItems(panel: HTMLElement | null) {
  return panel
    ? Array.from(panel.querySelectorAll<HTMLButtonElement>(".launcher-select-item:not(:disabled)"))
    : [];
}

/** Focus the checked item, or the first enabled one. */
function focusCheckedItem(panel: HTMLElement | null) {
  const items = enabledItems(panel);
  const checked = items.find((item) => item.getAttribute("aria-selected") === "true");
  (checked ?? items[0])?.focus({ preventScroll: true });
}

/* A native <select> can't tint a single option, so this is a custom listbox styled
   like the launcher's controls. The popover is portaled to <body> because the launcher
   and its options row both clip overflow, then pinned below the trigger like the
   composer menu. */
export function LauncherSelect({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  submenu,
  open: openProp,
  onOpenChange,
  anchorRef,
}: LauncherSelectProps) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const [anchor, setAnchor] = useState<{ left: number; top: number; width: number } | null>(null);
  const [submenuAnchor, setSubmenuAnchor] = useState<{ left: number; top: number } | null>(
    null,
  );
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const submenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const submenuRef = useRef<HTMLDivElement | null>(null);
  // Set when the submenu opens from the keyboard, so its checked item takes
  // focus once it is placed.
  const focusSubmenuRef = useRef(false);
  const submenuOpen = open && submenuAnchor !== null;
  const submenuSelected =
    submenu?.options.find((option) => option.value === submenu.value) ?? submenu?.options[0];

  const anchorElement = () => anchorRef?.current ?? triggerRef.current;

  const setOpen = (next: boolean) => {
    if (openProp === undefined) setOpenState(next);
    if (next !== open) onOpenChange?.(next);
  };
  // The document listeners below are bound once per open; they read the
  // latest setter through this ref.
  const setOpenRef = useRef(setOpen);
  setOpenRef.current = setOpen;

  /** Close the menu; from the keyboard or a choice, focus goes back to the
   * control that opened it. */
  const closeAll = (restoreFocus: boolean) => {
    setSubmenuAnchor(null);
    setOpen(false);
    if (restoreFocus) anchorElement()?.focus({ preventScroll: true });
  };

  const openSubmenu = (focus: boolean) => {
    const rect = submenuTriggerRef.current?.getBoundingClientRect();
    if (rect) {
      // Beside the row, top edges aligned; the layout effect below flips it
      // to the left when the right edge would leave the viewport.
      focusSubmenuRef.current = focus;
      setSubmenuAnchor({ left: rect.right + SUBMENU_GAP, top: rect.top - 4 });
    }
  };

  const closeSubmenu = (focusRow: boolean) => {
    // Focus inside the submenu would be dropped with it; keep it on the row.
    if (focusRow || submenuRef.current?.contains(document.activeElement)) {
      submenuTriggerRef.current?.focus({ preventScroll: true });
    }
    setSubmenuAnchor(null);
  };

  useLayoutEffect(() => {
    if (!submenuOpen) {
      return;
    }
    const panel = submenuRef.current?.getBoundingClientRect();
    const row = submenuTriggerRef.current?.getBoundingClientRect();
    if (!panel || !row || panel.right <= window.innerWidth - 8) {
      return;
    }
    setSubmenuAnchor((current) =>
      current ? { ...current, left: Math.max(8, row.left - panel.width - SUBMENU_GAP) } : current,
    );
  }, [submenuOpen]);
  useEffect(() => {
    if (submenuOpen && focusSubmenuRef.current) {
      focusSubmenuRef.current = false;
      focusCheckedItem(submenuRef.current);
    }
  }, [submenuOpen]);
  // A trigger near the viewport's right edge would push a left-aligned
  // popover off screen; end it at the trigger's right edge instead.
  useLayoutEffect(() => {
    if (!open || !anchor) {
      return;
    }
    const panel = popoverRef.current?.getBoundingClientRect();
    const trigger = anchorElement()?.getBoundingClientRect();
    if (!panel || !trigger || panel.right <= window.innerWidth - 8) {
      return;
    }
    const left = Math.max(8, Math.min(trigger.right, window.innerWidth - 8) - panel.width);
    if (left !== anchor.left) {
      setAnchor((current) => (current ? { ...current, left } : current));
    }
  }, [open, anchor]);
  const match = options.find((option) => option.value === value);
  const selected = match ?? options[0];

  // If the current value matches no option (e.g. a persisted choice that has since
  // been removed), the trigger would display options[0]'s label while the stored
  // value stayed orphaned — and launching would still send the stale value. Reconcile
  // to the displayed default so what's shown is what gets used.
  useEffect(() => {
    if (!match && options.length > 0 && options[0].value !== value) {
      onChange(options[0].value);
    }
  }, [match, options, value, onChange]);

  useEffect(() => {
    if (disabled && open) {
      setOpenRef.current(false);
      setSubmenuAnchor(null);
    }
  }, [disabled, open]);

  const measure = () => {
    const rect = anchorElement()?.getBoundingClientRect();
    if (rect) {
      // Pin the popover's top just below the trigger so it opens downward, left edge aligned.
      setAnchor({ left: rect.left, top: rect.bottom + 6, width: rect.width });
    }
  };

  // Placed before paint on every open, whichever control opened it.
  useLayoutEffect(() => {
    if (open) {
      measure();
    } else {
      setAnchor(null);
      setSubmenuAnchor(null);
    }
  }, [open]);

  // Focus moves into the menu once it is placed, so the arrow keys work at once.
  const shown = open && anchor !== null;
  useEffect(() => {
    if (shown) focusCheckedItem(popoverRef.current);
  }, [shown]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !anchorElement()?.contains(target) &&
        !popoverRef.current?.contains(target) &&
        !submenuRef.current?.contains(target)
      ) {
        setOpenRef.current(false);
        setSubmenuAnchor(null);
      }
    };
    // Keys pressed inside the menu are handled by menuKeyDown; these cover
    // focus left elsewhere while it is open.
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") {
        setOpenRef.current(false);
        setSubmenuAnchor(null);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", measure);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", measure);
    };
  }, [open]);

  /** ↑/↓ and Home/End move between enabled items; Escape closes this level
   * and Tab closes the menu, both returning focus to what opened it (Tab then
   * moves on from there). ← closes the submenu. */
  const menuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, isSubmenu: boolean) => {
    const items = enabledItems(event.currentTarget);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = researchMenuKeyTarget(event.key, index, items.length);
    if (next !== null) {
      event.preventDefault();
      items[next]?.focus({ preventScroll: true });
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (isSubmenu) closeSubmenu(true);
      else closeAll(true);
    } else if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.stopPropagation();
      closeAll(true);
    } else if (event.key === "ArrowLeft" && isSubmenu) {
      event.preventDefault();
      closeSubmenu(true);
    }
  };

  return (
    <>
      {anchorRef ? null : (
        <div className="launcher-select">
          <button
            ref={triggerRef}
            type="button"
            className={`control-button launcher-select-trigger${toneClass(selected?.tone)}`}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-label={ariaLabel}
            disabled={disabled}
            onClick={() => setOpen(!open)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && !open) {
                event.preventDefault();
                setOpen(true);
              }
            }}
          >
            <OptionIcon option={selected} />
            <span className="launcher-select-value">{selected?.label}</span>
            <ChevronDown size={13} className="launcher-select-chevron" aria-hidden="true" />
          </button>
        </div>
      )}
      {open && anchor
        ? createPortal(
            <div
              ref={popoverRef}
              className="popover-surface launcher-select-popover"
              role="listbox"
              aria-label={ariaLabel}
              style={{ left: anchor.left, top: anchor.top, minWidth: anchor.width }}
              onKeyDown={(event) => menuKeyDown(event, false)}
            >
              {options.map((option) => {
                const active = option.value === value;
                return (
                  <Fragment key={option.value}>
                    {option.dividerBefore ? (
                      <div
                        className="launcher-select-separator"
                        role="separator"
                        aria-hidden="true"
                      />
                    ) : null}
                    <button
                      type="button"
                      role="option"
                      aria-selected={active}
                      aria-disabled={option.disabled || undefined}
                      disabled={option.disabled}
                      className={`menu-item launcher-select-item${toneClass(option.tone)}${
                        active ? " is-active" : ""
                      }`}
                      onMouseEnter={() => closeSubmenu(false)}
                      onClick={() => {
                        closeAll(true);
                        if (option.value !== value) {
                          onChange(option.value);
                        }
                      }}
                    >
                      <OptionIcon option={option} />
                      <span className="launcher-select-item-label">{option.label}</span>
                      {option.detail ? (
                        <span className="launcher-select-item-detail">{option.detail}</span>
                      ) : null}
                      {active ? (
                        <Check size={14} className="launcher-select-check" aria-hidden="true" />
                      ) : null}
                    </button>
                  </Fragment>
                );
              })}
              {submenu ? (
                <>
                  <div className="launcher-select-separator" role="separator" aria-hidden="true" />
                  <button
                    ref={submenuTriggerRef}
                    type="button"
                    className={`menu-item launcher-select-item launcher-select-submenu-trigger${
                      submenuOpen ? " is-open" : ""
                    }`}
                    aria-haspopup="listbox"
                    aria-expanded={submenuOpen}
                    onMouseEnter={() => openSubmenu(false)}
                    // A keyboard click (Enter or Space) reports detail 0 and
                    // moves focus into the submenu; a mouse click does not.
                    onClick={(event) =>
                      submenuOpen ? closeSubmenu(true) : openSubmenu(event.detail === 0)
                    }
                    onKeyDown={(event) => {
                      if (event.key === "ArrowRight") {
                        event.preventDefault();
                        openSubmenu(true);
                      }
                    }}
                  >
                    <span className="launcher-select-item-label">{submenu.label}</span>
                    <span className="launcher-select-item-detail">{submenuSelected?.label}</span>
                    <ChevronRight
                      size={13}
                      className="launcher-select-submenu-chevron"
                      aria-hidden="true"
                    />
                  </button>
                </>
              ) : null}
            </div>,
            document.body,
          )
        : null}
      {submenu && submenuOpen && submenuAnchor
        ? createPortal(
            <div
              ref={submenuRef}
              className="popover-surface launcher-select-popover launcher-select-submenu"
              role="listbox"
              aria-label={submenu.ariaLabel ?? submenu.label}
              style={{ left: submenuAnchor.left, top: submenuAnchor.top }}
              onKeyDown={(event) => menuKeyDown(event, true)}
            >
              {submenu.options.map((option) => {
                const active = option.value === submenu.value;
                return (
                  <Fragment key={option.value}>
                    {option.dividerBefore ? (
                      <div
                        className="launcher-select-separator"
                        role="separator"
                        aria-hidden="true"
                      />
                    ) : null}
                    <button
                      type="button"
                      role="option"
                      aria-selected={active}
                      aria-disabled={option.disabled || undefined}
                      disabled={option.disabled}
                      className={`menu-item launcher-select-item${toneClass(option.tone)}${
                        active ? " is-active" : ""
                      }`}
                      onClick={() => {
                        closeAll(true);
                        if (option.value !== submenu.value) {
                          submenu.onChange(option.value);
                        }
                      }}
                    >
                      <span className="launcher-select-item-label">{option.label}</span>
                      {option.detail ? (
                        <span className="launcher-select-item-detail">{option.detail}</span>
                      ) : null}
                      {active ? (
                        <Check size={14} className="launcher-select-check" aria-hidden="true" />
                      ) : null}
                    </button>
                  </Fragment>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
