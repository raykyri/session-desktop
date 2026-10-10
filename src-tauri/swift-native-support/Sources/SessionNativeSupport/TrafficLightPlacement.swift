import AppKit

/// Centres the window buttons on the app's 44px header row (see `.titlebar-drag`
/// in shell.css). AppKit lays the title bar out again on resize, key changes and
/// full-screen transitions, so the placement is re-applied whenever the close
/// button moves or the window changes.
@MainActor
final class TrafficLightPlacement {
    /// The close button's left edge, in points from the window's left edge.
    static let leading: CGFloat = 16
    /// The buttons' vertical centre, in points from the window's top edge: level
    /// with the header controls, which sit 1px below the row's centre.
    static let centerY: CGFloat = 23

    private weak var window: NSWindow?
    private var observers: [NSObjectProtocol] = []
    private var spacing: CGFloat?
    private var applyPending = false
    private var applying = false

    func attach(to window: NSWindow) {
        if self.window === window {
            apply()
            return
        }
        detach()
        self.window = window
        let center = NotificationCenter.default
        let windowChanges: [Notification.Name] = [
            NSWindow.didResizeNotification,
            NSWindow.didEndLiveResizeNotification,
            NSWindow.didBecomeKeyNotification,
            NSWindow.didResignKeyNotification,
            NSWindow.didExitFullScreenNotification,
            NSWindow.didChangeBackingPropertiesNotification,
            NSWindow.didDeminiaturizeNotification,
        ]
        for name in windowChanges {
            observers.append(center.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.scheduleApply() }
            })
        }
        if let close = window.standardWindowButton(.closeButton) {
            close.postsFrameChangedNotifications = true
            observers.append(center.addObserver(
                forName: NSView.frameDidChangeNotification, object: close, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.scheduleApply() }
            })
        }
        apply()
    }

    func detach() {
        for observer in observers {
            NotificationCenter.default.removeObserver(observer)
        }
        observers.removeAll()
        window = nil
        spacing = nil
    }

    private func scheduleApply() {
        guard !applyPending else { return }
        applyPending = true
        // After AppKit's own title-bar layout for this change has run.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.applyPending = false
            self.apply()
        }
    }

    func apply() {
        // Skip placement in full screen, where the menu-bar toolbar contains the buttons.
        guard let window, !applying, !window.styleMask.contains(.fullScreen) else { return }
        let buttons = [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton]
            .compactMap { window.standardWindowButton($0) }
        guard let close = buttons.first, let container = close.superview?.superview else { return }
        applying = true
        defer { applying = false }

        // Keep the system's spacing, measured before the first move.
        if spacing == nil, buttons.count > 1 {
            spacing = buttons[1].frame.minX - close.frame.minX
        }
        let step = spacing ?? 20
        let size = close.frame.size
        let windowHeight = window.frame.height

        // Extend the title-bar container below the buttons so they receive clicks.
        // Increase its height as needed while keeping its top aligned with the window.
        let neededHeight = (Self.centerY + size.height / 2 + 2).rounded(.up)
        if container.frame.height < neededHeight {
            var frame = container.frame
            frame.size.height = neededHeight
            frame.origin.y = windowHeight - neededHeight
            container.frame = frame
        }

        for (index, button) in buttons.enumerated() {
            guard let superview = button.superview else { continue }
            // Window base coordinates have their origin at the bottom-left.
            let target = NSRect(
                x: Self.leading + CGFloat(index) * step,
                y: windowHeight - Self.centerY - size.height / 2,
                width: size.width,
                height: size.height
            )
            let origin = superview.convert(target, from: nil).origin
            if abs(button.frame.minX - origin.x) > 0.25 || abs(button.frame.minY - origin.y) > 0.25 {
                button.setFrameOrigin(origin)
            }
        }
    }
}
