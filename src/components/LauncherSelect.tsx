import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronRight } from "lucide-react";

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
  /** Show only the selected option's icon on the trigger; its label moves to
   * the trigger's tooltip. */
  iconOnly?: boolean;
}

const SUBMENU_GAP = 4;

const toneClass = (tone?: string) => (tone ? ` is-${tone}` : "");
const iconClass = (option?: LauncherSelectOption) =>
  ["launcher-select-icon", option?.iconClassName].filter(Boolean).join(" ");

function OptionIcon({ option }: { option?: LauncherSelectOption }) {
  if (option?.iconSrc) {
    return <img className={iconClass(option)} src={option.iconSrc} alt="" aria-hidden="true" />;
  }
  return option?.icon ? (
    <span className={iconClass(option)} aria-hidden="true">
      {option.icon}
    </span>
  ) : null;
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
  iconOnly = false,
}: LauncherSelectProps) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; top: number; width: number } | null>(null);
  const [submenuAnchor, setSubmenuAnchor] = useState<{ left: number; top: number } | null>(
    null,
  );
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const submenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const submenuRef = useRef<HTMLDivElement | null>(null);
  const submenuOpen = open && submenuAnchor !== null;
  const submenuSelected =
    submenu?.options.find((option) => option.value === submenu.value) ?? submenu?.options[0];

  const closeAll = () => {
    setOpen(false);
    setSubmenuAnchor(null);
  };

  const openSubmenu = () => {
    const rect = submenuTriggerRef.current?.getBoundingClientRect();
    if (rect) {
      // Beside the row, top edges aligned; the layout effect below flips it
      // to the left when the right edge would leave the viewport.
      setSubmenuAnchor({ left: rect.right + SUBMENU_GAP, top: rect.top - 4 });
    }
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
  // A trigger near the viewport's right edge (the Home composer's model
  // picker ends its row) would push a left-aligned popover off screen; end
  // it at the trigger's right edge instead.
  useLayoutEffect(() => {
    if (!open || !anchor) {
      return;
    }
    const panel = popoverRef.current?.getBoundingClientRect();
    const trigger = triggerRef.current?.getBoundingClientRect();
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
    if (disabled) {
      setOpen(false);
      setSubmenuAnchor(null);
    }
  }, [disabled]);

  const measure = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      // Pin the popover's top just below the trigger so it opens downward, left edge aligned.
      setAnchor({ left: rect.left, top: rect.bottom + 6, width: rect.width });
    }
  };

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !popoverRef.current?.contains(target) &&
        !submenuRef.current?.contains(target)
      ) {
        setOpen(false);
        setSubmenuAnchor(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") {
        setOpen(false);
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

  return (
    <div className="launcher-select">
      <button
        ref={triggerRef}
        type="button"
        className={`control-button launcher-select-trigger${toneClass(selected?.tone)}${
          iconOnly ? " is-icon-only" : ""
        }`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={iconOnly ? selected?.label : undefined}
        disabled={disabled}
        onClick={() => {
          if (!open) {
            measure();
          }
          setSubmenuAnchor(null);
          setOpen((prev) => !prev);
        }}
      >
        <OptionIcon option={selected} />
        {iconOnly ? null : <span className="launcher-select-value">{selected?.label}</span>}
        <ChevronDown size={13} className="launcher-select-chevron" aria-hidden="true" />
      </button>
      {open && anchor
        ? createPortal(
            <div
              ref={popoverRef}
              className="popover-surface launcher-select-popover"
              role="listbox"
              aria-label={ariaLabel}
              style={{ left: anchor.left, top: anchor.top, minWidth: anchor.width }}
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
                      onMouseEnter={() => setSubmenuAnchor(null)}
                      onClick={() => {
                        closeAll();
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
                    onMouseEnter={openSubmenu}
                    onClick={() => (submenuOpen ? setSubmenuAnchor(null) : openSubmenu())}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowRight") {
                        event.preventDefault();
                        openSubmenu();
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
                        closeAll();
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
    </div>
  );
}
