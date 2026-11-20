// The transparent layer under a popover (the mockup's `um-scrim`): a click
// outside the popover closes it. Keyboard users close it with Escape
// (`useOverlay`), so the layer itself takes no focus and has no role.

export function Scrim({ onClose }: { onClose: () => void }) {
  return <div className="um-scrim" aria-hidden="true" onClick={onClose} />;
}
