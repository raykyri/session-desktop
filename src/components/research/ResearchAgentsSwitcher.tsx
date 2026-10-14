import { useRef, useState } from "react";
import { Bot, ChevronDown, RefreshCw, Wrench } from "lucide-react";
import type { AgentAdapterMetadata } from "../../types";
import { ADAPTER_ICON_BY_ID, adapterIconClassName } from "../../lib/adapterIcons";
import {
  adapterSetupIsComplete,
  agentSetupStatusLabel,
  agentSetupSummary,
} from "../../lib/agentSetup";
import {
  ResearchMenu,
  ResearchMenuItem,
  ResearchMenuSeparator,
  type ResearchMenuRect,
} from "./ResearchMenu";
import { ResearchRailButton } from "./ResearchSidebarNav";

const MENU_WIDTH = 264;

interface ResearchAgentsSwitcherProps {
  /** Null until the runtime config has loaded. */
  adapters: readonly AgentAdapterMetadata[] | null;
  /** A readiness probe is running; Refresh status is disabled meanwhile. */
  loading: boolean;
  /** The last readiness probe's error. */
  error: string | null;
  /** "rail": an icon in the collapsed sidebar whose menu opens beside the rail. */
  variant?: "sidebar" | "rail";
  /** Opens the Agent Setup dialog on an agent instance, or on the first agent
   * whose setup is incomplete when null. */
  onOpenSetup: (adapterId: string | null) => void;
  onRefresh: () => void;
}

/** The Agents module at the bottom of the sidebar, between the workspace
 * switcher and the GitHub account control. It summarizes agent readiness and
 * opens a menu listing each agent instance with its status. */
export default function ResearchAgentsSwitcher({
  adapters,
  loading,
  error,
  variant = "sidebar",
  onOpenSetup,
  onRefresh,
}: ResearchAgentsSwitcherProps) {
  const rail = variant === "rail";
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  /** The open menu's trigger and what it is placed against: the trigger, or
   * in the rail, the rail's edge level with the icon. Null while closed. */
  const [placement, setPlacement] = useState<{
    trigger: HTMLElement;
    anchor: HTMLElement | ResearchMenuRect;
  } | null>(null);
  const open = placement !== null;

  const show = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    if (!rail) {
      setPlacement({ trigger, anchor: trigger });
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const railRight = trigger.closest(".research-rail")?.getBoundingClientRect().right ?? rect.right;
    setPlacement({
      trigger,
      anchor: { left: rect.left, top: rect.top, right: railRight, bottom: rect.bottom },
    });
  };
  const close = (restoreFocus: boolean) => {
    setPlacement(null);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  };
  const toggle = () => (open ? close(false) : show());

  const summary = agentSetupSummary(adapters, error);
  const dot = (
    <span className={`sidebar-agents-dot is-${summary.tone}`} aria-hidden="true" />
  );

  const menu = placement ? (
    <ResearchMenu
      anchor={placement.anchor}
      align={rail ? "side" : "start"}
      trigger={placement.trigger}
      label="Agents"
      width={MENU_WIDTH}
      onClose={() => close(false)}
    >
      {(adapters ?? []).map((adapter) => {
        const iconUrl = ADAPTER_ICON_BY_ID[adapter.id];
        const ready = adapterSetupIsComplete(adapter);
        return (
          <ResearchMenuItem
            key={adapter.id}
            icon={
              iconUrl ? (
                <img
                  src={iconUrl}
                  className={`agent-setup-icon ${adapterIconClassName(adapter.id) ?? ""}`}
                  alt=""
                  aria-hidden="true"
                />
              ) : (
                <Bot size={15} aria-hidden="true" />
              )
            }
            label={adapter.label}
            detail={agentSetupStatusLabel(adapter)}
            trailing={
              <span
                className={`sidebar-agents-dot is-${ready ? "ready" : "neutral"}`}
                aria-hidden="true"
              />
            }
            onSelect={() => {
              close(false);
              onOpenSetup(adapter.id);
            }}
          />
        );
      })}
      {adapters && adapters.length > 0 ? <ResearchMenuSeparator /> : null}
      {adapters && adapters.length > 0 ? (
        <ResearchMenuItem
          icon={<RefreshCw size={15} aria-hidden="true" />}
          label="Refresh status"
          disabled={loading}
          onSelect={() => {
            close(true);
            onRefresh();
          }}
        />
      ) : null}
      <ResearchMenuItem
        icon={<Wrench size={15} aria-hidden="true" />}
        label="Agent setup…"
        onSelect={() => {
          close(false);
          onOpenSetup(null);
        }}
      />
    </ResearchMenu>
  ) : null;

  if (rail) {
    return (
      <div className="sidebar-agents is-rail">
        <ResearchRailButton
          label="Agents"
          description={`Agents: ${summary.text}`}
          buttonRef={triggerRef}
          popup
          expanded={open}
          onClick={toggle}
        >
          <Bot size={16} aria-hidden="true" />
        </ResearchRailButton>
        {menu}
      </div>
    );
  }

  return (
    <div className="sidebar-agents">
      <button
        ref={triggerRef}
        type="button"
        className="control-button research-folder-trigger sidebar-agents-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Agents: ${summary.text}`}
        onClick={toggle}
      >
        <Bot size={13} aria-hidden="true" />
        <span className="research-folder-trigger-copy">
          <span className="research-folder-trigger-name">Agents</span>
          <span className="research-folder-path sidebar-agents-status">
            {summary.tone === "neutral" ? null : dot}
            <span className="sidebar-agents-status-text">{summary.text}</span>
          </span>
        </span>
        <ChevronDown size={13} aria-hidden="true" className={open ? "is-open" : undefined} />
      </button>
      {menu}
    </div>
  );
}
