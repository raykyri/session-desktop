import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import type { ReactNode } from "react";

import { cn } from "../lib/cn.js";

import { FOCUS_RING } from "./surfaces.js";

export interface TabsProps {
  value: string;
  onValueChange: (value: string) => void;
  tabs: readonly { value: string; label: string }[];
  children: ReactNode;
  className?: string;
  label?: string;
}

/** The Settings section switcher (08 §4). */
export function Tabs({ value, onValueChange, tabs, children, className, label }: TabsProps) {
  return (
    <BaseTabs.Root
      value={value}
      onValueChange={(next) => onValueChange(String(next))}
      className={className}
    >
      <BaseTabs.List aria-label={label} className="border-border-divider flex gap-1 border-b pb-2">
        {tabs.map((tab) => (
          <BaseTabs.Tab
            key={tab.value}
            value={tab.value}
            className={cn(
              "min-h-control-md cursor-pointer rounded-md border-0 bg-transparent px-3 text-base",
              "text-fg-secondary hover:text-fg-strong transition-colors duration-[120ms]",
              "data-selected:bg-surface-tab-active data-selected:text-fg-strong",
              FOCUS_RING,
            )}
          >
            {tab.label}
          </BaseTabs.Tab>
        ))}
      </BaseTabs.List>
      {children}
    </BaseTabs.Root>
  );
}

export function TabPanel({
  value,
  children,
  className,
}: {
  value: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <BaseTabs.Panel value={value} className={cn("pt-4 outline-none", className)}>
      {children}
    </BaseTabs.Panel>
  );
}
