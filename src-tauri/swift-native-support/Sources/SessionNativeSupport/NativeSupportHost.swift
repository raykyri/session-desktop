@preconcurrency import AppKit
import WebKit

@_silgen_name("session_native_support_did_receive_app_shortcut")
private func nativeSupportDidReceiveAppShortcut(
    _ key: UnsafePointer<CChar>,
    _ shift: Int32,
    _ control: Int32,
    _ option: Int32,
    _ command: Int32,
    _ repeat: Int32
) -> Int32

@_silgen_name("session_native_support_did_request_browser_escape")
private func nativeSupportDidRequestBrowserEscape() -> Int32

@_silgen_name("session_native_support_did_begin_interface_health_check")
private func nativeSupportDidBeginInterfaceHealthCheck() -> UInt64

@_silgen_name("session_native_support_did_cancel_interface_health_check")
private func nativeSupportDidCancelInterfaceHealthCheck()

@_silgen_name("session_native_support_did_detect_unhealthy_webview")
private func nativeSupportDidDetectUnhealthyWebView(_ generation: UInt64)

@_silgen_name("session_native_support_system_sleep_changed")
private func nativeSupportSystemSleepChanged(_ sleeping: Int32)

@MainActor
final class NativeSupportHost {
    static let shared = NativeSupportHost()
    private weak var appWebView: WKWebView?
    private weak var humanBrowserWebView: WKWebView?
    private weak var boundWindow: NSWindow?
    private var closeObserver: NSObjectProtocol?
    private var consumedAppShortcutKeyCodes: Set<UInt16> = []
    private var iframeShortcutFallbackActive = false
    private var browserOverlayOpen = false
    // Session's document background, available before the frontend starts.
    private var browserBackground = NSColor(srgbRed: 17.0 / 255, green: 19.0 / 255, blue: 21.0 / 255, alpha: 1)
    private var eventMonitor: Any?
    private var resignKeyObserver: NSObjectProtocol?
    private var becomeKeyObserver: NSObjectProtocol?
    private var appBecameActiveObserver: NSObjectProtocol?
    private var appResignedActiveObserver: NSObjectProtocol?
    private var windowMiniaturizedObserver: NSObjectProtocol?
    private var windowDeminiaturizedObserver: NSObjectProtocol?
    private var screenParametersObserver: NSObjectProtocol?
    private var workspaceWakeObserver: NSObjectProtocol?
    private var workspaceWillSleepObserver: NSObjectProtocol?
    private var interfaceHealthCheckPending = false
    private var interfaceHealthCheckInFlight = false
    private var memoryPressureSource: DispatchSourceMemoryPressure?
    private var lifecycleGapTimer: DispatchSourceTimer?
    private var memoryPressureCritical = false
    private var inactiveSince: TimeInterval?
    private var lastLifecycleTick = ProcessInfo.processInfo.systemUptime
    private var webViewHealthProbeGeneration: UInt64 = 0
    private var webViewHealthRustGeneration: UInt64?
    private var webViewHealthSnapshotAttempt = 0
    private let trafficLights = TrafficLightPlacement()

    private init() {}

    // Tauri may attach the view before assigning its window. Resolve that late
    // binding from the app view, never from an external browser or renderer.
    private var window: NSWindow? {
        if let current = appWebView?.window {
            boundWindow = current
        }
        return boundWindow
    }

    func attach(to suppliedView: NSView) -> Bool {
        guard let webView = findWebView(in: suppliedView) as? WKWebView else {
            shutdown()
            return false
        }
        if appWebView === webView { return true }
        shutdown()
        appWebView = webView
        boundWindow = webView.window
        placeTrafficLights(for: webView, attemptsLeft: 40)
        installEventMonitor()
        closeObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification, object: nil, queue: .main
        ) { notification in
            let closed = notification.object as? NSWindow
            MainActor.assumeIsolated {
                let host = NativeSupportHost.shared
                if let closed, closed === host.window { host.shutdown() }
            }
        }
        return true
    }

    func setBrowserBackground(red: Double, green: Double, blue: Double) -> Bool {
        guard [red, green, blue].allSatisfy({ $0.isFinite && (0...1).contains($0) }) else {
            return false
        }
        browserBackground = NSColor(srgbRed: red, green: green, blue: blue, alpha: 1)
        return true
    }

    func setIframeShortcutFallback(_ active: Bool) -> Bool {
        guard appWebView != nil else { return false }
        iframeShortcutFallbackActive = active
        return true
    }

    func setBrowserOverlayOpen(_ active: Bool) -> Bool {
        guard appWebView != nil else { return false }
        browserOverlayOpen = active
        return true
    }

    func setHumanBrowserWebView(_ webView: WKWebView?, active: Bool) -> Bool {
        guard appWebView != nil else { return false }
        if active {
            guard let webView else { return false }
            humanBrowserWebView = webView
            iframeShortcutFallbackActive = false
            return true
        }

        guard humanBrowserWebView == nil || humanBrowserWebView === webView else {
            return true
        }
        if let humanBrowserWebView,
           let window,
           let responder = window.firstResponder as? NSView,
           responder === humanBrowserWebView
               || responder.isDescendant(of: humanBrowserWebView)
        {
            window.makeFirstResponder(appWebView)
        }
        humanBrowserWebView = nil
        return true
    }

    func setHumanBrowserLoadingBackground(_ webView: WKWebView?, active: Bool) -> Bool {
        guard let webView else { return false }
        webView.underPageBackgroundColor = active
            ? browserBackground
            : nil
        return true
    }

    func prepareForWebViewReload() -> Bool {
        guard appWebView != nil else { return false }
        webViewHealthProbeGeneration &+= 1
        nativeSupportDidCancelInterfaceHealthCheck()
        interfaceHealthCheckPending = false
        interfaceHealthCheckInFlight = false
        webViewHealthRustGeneration = nil
        resetInterruptedInputState()
        iframeShortcutFallbackActive = false
        browserOverlayOpen = false
        humanBrowserWebView = nil
        return true
    }

    // The window may be assigned after attach; retry briefly until it exists.
    private func placeTrafficLights(for webView: WKWebView, attemptsLeft: Int) {
        guard appWebView === webView else { return }
        if let window = webView.window {
            trafficLights.attach(to: window)
            return
        }
        guard attemptsLeft > 0 else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self, weak webView] in
            guard let self, let webView else { return }
            self.placeTrafficLights(for: webView, attemptsLeft: attemptsLeft - 1)
        }
    }

    func shutdown() {
        trafficLights.detach()
        if let eventMonitor {
            NSEvent.removeMonitor(eventMonitor)
            self.eventMonitor = nil
        }
        if let resignKeyObserver {
            NotificationCenter.default.removeObserver(resignKeyObserver)
            self.resignKeyObserver = nil
        }
        if let becomeKeyObserver {
            NotificationCenter.default.removeObserver(becomeKeyObserver)
            self.becomeKeyObserver = nil
        }
        if let appBecameActiveObserver {
            NotificationCenter.default.removeObserver(appBecameActiveObserver)
            self.appBecameActiveObserver = nil
        }
        if let appResignedActiveObserver {
            NotificationCenter.default.removeObserver(appResignedActiveObserver)
            self.appResignedActiveObserver = nil
        }
        if let windowMiniaturizedObserver {
            NotificationCenter.default.removeObserver(windowMiniaturizedObserver)
            self.windowMiniaturizedObserver = nil
        }
        if let windowDeminiaturizedObserver {
            NotificationCenter.default.removeObserver(windowDeminiaturizedObserver)
            self.windowDeminiaturizedObserver = nil
        }
        if let screenParametersObserver {
            NotificationCenter.default.removeObserver(screenParametersObserver)
            self.screenParametersObserver = nil
        }
        if let workspaceWakeObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(workspaceWakeObserver)
            self.workspaceWakeObserver = nil
        }
        if let workspaceWillSleepObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(workspaceWillSleepObserver)
            self.workspaceWillSleepObserver = nil
        }
        memoryPressureSource?.cancel()
        memoryPressureSource = nil
        lifecycleGapTimer?.cancel()
        lifecycleGapTimer = nil
        interfaceHealthCheckPending = false
        interfaceHealthCheckInFlight = false
        memoryPressureCritical = false
        inactiveSince = nil
        webViewHealthProbeGeneration &+= 1
        webViewHealthRustGeneration = nil
        nativeSupportDidCancelInterfaceHealthCheck()
        consumedAppShortcutKeyCodes.removeAll()
        iframeShortcutFallbackActive = false
        browserOverlayOpen = false
        if let closeObserver {
            NotificationCenter.default.removeObserver(closeObserver)
            self.closeObserver = nil
        }
        humanBrowserWebView = nil
        appWebView = nil
        boundWindow = nil
    }

    private func findWebView(in root: NSView) -> NSView? {
        if root is WKWebView {
            return root
        }
        for child in root.subviews {
            if let result = findWebView(in: child) {
                return result
            }
        }
        return nil
    }

    private func windowDidResignKey(_ resigned: NSWindow?) {
        guard let resigned, resigned === window else { return }
        consumedAppShortcutKeyCodes.removeAll()
    }

    private func systemDidWake() {
        nativeSupportSystemSleepChanged(0)
        requestInterfaceRecovery()
    }

    private func systemWillSleep() {
        nativeSupportSystemSleepChanged(1)
        resetInterruptedInputState()
        interfaceHealthCheckPending = false
        interfaceHealthCheckInFlight = false
        webViewHealthProbeGeneration &+= 1
        webViewHealthRustGeneration = nil
        nativeSupportDidCancelInterfaceHealthCheck()
    }

    private func applicationDidResignActive() {
        inactiveSince = ProcessInfo.processInfo.systemUptime
        resetInterruptedInputState()
        deferInterfaceHealthCheckIfNeeded()
    }

    private func applicationDidBecomeActive() {
        let now = ProcessInfo.processInfo.systemUptime
        // Ordinary app switching does not require a reload. A
        // five-minute absence is long enough to plausibly include App Nap or
        // an OS-level suspension; shorter stalls are covered precisely by the
        // main-queue gap detector instead.
        if let inactiveSince, now - inactiveSince >= 5 * 60 {
            requestInterfaceRecovery()
        } else {
            scheduleInterfaceHealthCheckIfVisible()
        }
        self.inactiveSince = nil
    }

    private func lifecycleTimerDidFire() {
        let now = ProcessInfo.processInfo.systemUptime
        let schedulingGap = now - lastLifecycleTick
        lastLifecycleTick = now
        // A normal five-second main-queue timer should not miss three complete
        // intervals. A longer gap means the process was suspended or the main
        // actor was starved badly enough that its renderers merit validation.
        if schedulingGap >= 15 {
            requestInterfaceRecovery()
        }
    }

    private func memoryPressureDidChange(_ event: DispatchSource.MemoryPressureEvent) {
        if event.contains(.warning) || event.contains(.critical) {
            memoryPressureCritical = true
            resetInterruptedInputState()
            interfaceHealthCheckPending = true
            deferInterfaceHealthCheckIfNeeded()
            return
        }
        if event.contains(.normal) {
            memoryPressureCritical = false
            scheduleInterfaceHealthCheckIfVisible()
        }
    }

    private func requestInterfaceRecovery() {
        resetInterruptedInputState()
        interfaceHealthCheckPending = true
        scheduleInterfaceHealthCheckIfVisible()
    }

    private func resetInterruptedInputState() {
        consumedAppShortcutKeyCodes.removeAll()
    }

    private func deferInterfaceHealthCheckIfNeeded(_ changedWindow: NSWindow? = nil) {
        if let changedWindow, changedWindow !== window {
            return
        }
        guard interfaceHealthCheckPending || interfaceHealthCheckInFlight ||
                webViewHealthRustGeneration != nil
        else { return }
        interfaceHealthCheckPending = true
        interfaceHealthCheckInFlight = false
        webViewHealthProbeGeneration &+= 1
        webViewHealthRustGeneration = nil
        nativeSupportDidCancelInterfaceHealthCheck()
    }

    private func isEligibleForInterfaceHealthCheck(_ candidate: NSWindow) -> Bool {
        !memoryPressureCritical &&
            NSApp.isActive &&
            candidate === window &&
            candidate.isVisible &&
            !candidate.isMiniaturized
    }

    private func scheduleInterfaceHealthCheckIfVisible() {
        guard interfaceHealthCheckPending,
              !memoryPressureCritical,
              NSApp.isActive,
              let window,
              window.isVisible,
              !window.isMiniaturized
        else { return }
        interfaceHealthCheckPending = false
        interfaceHealthCheckInFlight = true
        webViewHealthProbeGeneration &+= 1
        let generation = webViewHealthProbeGeneration
        // Give WindowServer/WebKit a short grace period to reconnect after a
        // wake, process suspension, or display/GPU transition.
        // The actual watchdog below is deliberately much longer, so ordinary
        // resume scheduling or a busy frontend cannot trigger a reload.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self,
                  generation == self.webViewHealthProbeGeneration
            else { return }
            guard NSApp.isActive,
                  let window = self.window,
                  window.isVisible,
                  !window.isMiniaturized,
                  !self.memoryPressureCritical
            else {
                self.interfaceHealthCheckPending = true
                self.interfaceHealthCheckInFlight = false
                return
            }
            self.startInterfaceHealthCheck(in: window, generation: generation)
        }
    }

    private func startInterfaceHealthCheck(in window: NSWindow, generation: UInt64) {
        // This event requires an acknowledgement from the current document, so
        // it catches a dead JavaScript event loop even when WebKit did not report
        // a WebContent process termination.
        let rustGeneration = nativeSupportDidBeginInterfaceHealthCheck()
        webViewHealthRustGeneration = rustGeneration == 0 ? nil : rustGeneration
        webViewHealthSnapshotAttempt = 0
        takeInterfaceHealthSnapshot(
            in: window,
            generation: generation,
            rustGeneration: rustGeneration,
            attempt: 0
        )
    }

    private func takeInterfaceHealthSnapshot(
        in window: NSWindow,
        generation: UInt64,
        rustGeneration: UInt64,
        attempt: Int
    ) {
        guard generation == webViewHealthProbeGeneration,
              attempt == webViewHealthSnapshotAttempt
        else { return }
        guard isEligibleForInterfaceHealthCheck(window) else {
            deferInterfaceHealthCheckIfNeeded(window)
            return
        }
        // A JavaScript round-trip alone is insufficient for the observed failure:
        // WebKit's GPU process can die while WebContent remains responsive. A tiny
        // native snapshot exercises the compositor without allocating a full-window
        // image under the same memory pressure that caused the original failure.
        guard let webView = appWebView,
              webView.bounds.width > 0,
              webView.bounds.height > 0
        else {
            finishInterfaceHealthSnapshot(
                generation: generation,
                rustGeneration: rustGeneration,
                attempt: attempt,
                healthy: false
            )
            return
        }
        let configuration = WKSnapshotConfiguration()
        configuration.rect = CGRect(
            x: 0,
            y: 0,
            width: min(webView.bounds.width, 64),
            height: min(webView.bounds.height, 64)
        )
        webView.takeSnapshot(with: configuration) { [weak self] image, error in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    self?.finishInterfaceHealthSnapshot(
                        generation: generation,
                        rustGeneration: rustGeneration,
                        attempt: attempt,
                        healthy: image != nil && error == nil
                    )
                }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
            guard let self,
                  generation == self.webViewHealthProbeGeneration,
                  attempt == self.webViewHealthSnapshotAttempt
            else { return }
            self.finishInterfaceHealthSnapshot(
                generation: generation,
                rustGeneration: rustGeneration,
                attempt: attempt,
                healthy: false
            )
        }
    }

    private func finishInterfaceHealthSnapshot(
        generation: UInt64,
        rustGeneration: UInt64,
        attempt: Int,
        healthy: Bool
    ) {
        guard generation == webViewHealthProbeGeneration,
              attempt == webViewHealthSnapshotAttempt
        else { return }
        guard let window, isEligibleForInterfaceHealthCheck(window) else {
            deferInterfaceHealthCheckIfNeeded()
            return
        }
        if healthy {
            interfaceHealthCheckInFlight = false
            webViewHealthProbeGeneration &+= 1
            // Rust's event-loop watchdog owns the generation until its
            // acknowledgement window closes. Forget it just after that so a
            // much later app hide does not schedule a redundant recovery probe.
            DispatchQueue.main.asyncAfter(deadline: .now() + 8.25) { [weak self] in
                guard let self,
                      self.webViewHealthRustGeneration == rustGeneration
                else { return }
                self.webViewHealthRustGeneration = nil
            }
            return
        }
        if attempt == 0 {
            webViewHealthSnapshotAttempt = 1
            // A first failed/missing snapshot can be transient while WebKit's
            // GPU process reconnects. Retry once after a short foreground-only
            // delay before allowing the compositor half to claim a reload.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.65) { [weak self] in
                guard let self,
                      generation == self.webViewHealthProbeGeneration,
                      self.webViewHealthSnapshotAttempt == 1
                else { return }
                guard let window = self.window,
                      self.isEligibleForInterfaceHealthCheck(window)
                else {
                    self.deferInterfaceHealthCheckIfNeeded()
                    return
                }
                self.takeInterfaceHealthSnapshot(
                    in: window,
                    generation: generation,
                    rustGeneration: rustGeneration,
                    attempt: 1
                )
            }
            return
        }
        interfaceHealthCheckInFlight = false
        webViewHealthProbeGeneration &+= 1
        if rustGeneration != 0 {
            nativeSupportDidDetectUnhealthyWebView(rustGeneration)
            DispatchQueue.main.asyncAfter(deadline: .now() + 8.25) { [weak self] in
                guard let self,
                      self.webViewHealthRustGeneration == rustGeneration
                else { return }
                self.webViewHealthRustGeneration = nil
            }
        }
    }

    private func installEventMonitor() {
        guard eventMonitor == nil else { return }
        if resignKeyObserver == nil {
            resignKeyObserver = NotificationCenter.default.addObserver(
                forName: NSWindow.didResignKeyNotification,
                object: nil,
                queue: .main
            ) { notification in
                // Delivered on the main queue; hop into the main actor for the
                // host's state. The window comparison happens inside, since the
                // host resolves its window lazily.
                let resigned = notification.object as? NSWindow
                MainActor.assumeIsolated {
                    NativeSupportHost.shared.windowDidResignKey(resigned)
                }
            }
        }
        if becomeKeyObserver == nil {
            becomeKeyObserver = NotificationCenter.default.addObserver(
                forName: NSWindow.didBecomeKeyNotification,
                object: nil,
                queue: .main
            ) { _ in
                MainActor.assumeIsolated {
                    NativeSupportHost.shared.scheduleInterfaceHealthCheckIfVisible()
                }
            }
        }
        if appBecameActiveObserver == nil {
            appBecameActiveObserver = NotificationCenter.default.addObserver(
                forName: NSApplication.didBecomeActiveNotification,
                object: nil,
                queue: .main
            ) { _ in
                MainActor.assumeIsolated {
                    NativeSupportHost.shared.applicationDidBecomeActive()
                }
            }
        }
        if appResignedActiveObserver == nil {
            appResignedActiveObserver = NotificationCenter.default.addObserver(
                forName: NSApplication.didResignActiveNotification,
                object: nil,
                queue: .main
            ) { _ in
                MainActor.assumeIsolated {
                    NativeSupportHost.shared.applicationDidResignActive()
                }
            }
        }
        if windowMiniaturizedObserver == nil {
            windowMiniaturizedObserver = NotificationCenter.default.addObserver(
                forName: NSWindow.didMiniaturizeNotification,
                object: nil,
                queue: .main
            ) { notification in
                let changedWindow = notification.object as? NSWindow
                MainActor.assumeIsolated {
                    NativeSupportHost.shared.deferInterfaceHealthCheckIfNeeded(changedWindow)
                }
            }
        }
        if windowDeminiaturizedObserver == nil {
            windowDeminiaturizedObserver = NotificationCenter.default.addObserver(
                forName: NSWindow.didDeminiaturizeNotification,
                object: nil,
                queue: .main
            ) { notification in
                let changedWindow = notification.object as? NSWindow
                MainActor.assumeIsolated {
                    guard changedWindow === NativeSupportHost.shared.window else { return }
                    NativeSupportHost.shared.scheduleInterfaceHealthCheckIfVisible()
                }
            }
        }
        if screenParametersObserver == nil {
            screenParametersObserver = NotificationCenter.default.addObserver(
                forName: NSApplication.didChangeScreenParametersNotification,
                object: nil,
                queue: .main
            ) { _ in
                MainActor.assumeIsolated {
                    NativeSupportHost.shared.requestInterfaceRecovery()
                }
            }
        }
        if workspaceWakeObserver == nil {
            workspaceWakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
                forName: NSWorkspace.didWakeNotification,
                object: nil,
                queue: .main
            ) { _ in
                MainActor.assumeIsolated {
                    NativeSupportHost.shared.systemDidWake()
                }
            }
        }
        if workspaceWillSleepObserver == nil {
            workspaceWillSleepObserver = NSWorkspace.shared.notificationCenter.addObserver(
                forName: NSWorkspace.willSleepNotification,
                object: nil,
                queue: .main
            ) { _ in
                MainActor.assumeIsolated {
                    NativeSupportHost.shared.systemWillSleep()
                }
            }
        }
        if memoryPressureSource == nil {
            let source = DispatchSource.makeMemoryPressureSource(
                eventMask: [.normal, .warning, .critical],
                queue: .main
            )
            source.setEventHandler { [weak self] in
                MainActor.assumeIsolated {
                    guard let self, let event = self.memoryPressureSource?.data else { return }
                    self.memoryPressureDidChange(event)
                }
            }
            memoryPressureSource = source
            source.activate()
        }
        if lifecycleGapTimer == nil {
            lastLifecycleTick = ProcessInfo.processInfo.systemUptime
            let timer = DispatchSource.makeTimerSource(queue: .main)
            timer.schedule(deadline: .now() + 5, repeating: 5, leeway: .seconds(1))
            timer.setEventHandler { [weak self] in
                MainActor.assumeIsolated {
                    self?.lifecycleTimerDidFire()
                }
            }
            lifecycleGapTimer = timer
            timer.activate()
        }
        let mask: NSEvent.EventTypeMask = [.keyDown, .keyUp]
        eventMonitor = NSEvent.addLocalMonitorForEvents(matching: mask) {
            @MainActor [weak self] event in
            guard let self else { return event }
            return routeEvent(event)
        }
    }

    private func isInWebView(_ view: NSView) -> Bool {
        var current: NSView? = view
        while let candidate = current {
            if candidate is WKWebView {
                return true
            }
            current = candidate.superview
        }
        return false
    }

    private func claimWebAppShortcut(_ event: NSEvent) -> Bool {
        guard event.type == .keyDown,
              let window,
              event.window === window,
              let shortcutKey = appShortcutKey(for: event)
        else {
            return false
        }
        let responderState = webAppShortcutResponderState(in: window)
        if responderState == .humanBrowser,
           humanBrowserDefersEditableSensitiveShortcut(
               key: shortcutKey,
               shift: event.modifierFlags.contains(.shift),
               control: event.modifierFlags.contains(.control),
               option: event.modifierFlags.contains(.option),
               command: event.modifierFlags.contains(.command)
           )
        {
            return false
        }
        guard
              shouldClaimWebAppShortcut(
                  hasTerminalKeyboardOwner: false,
                  responderState: responderState,
                  // Only ⌘ chords are pulled out of a focused iframe; option
                  // and bare-control chords (word navigation, readline-style
                  // editing) stay with the framed page, mirroring how the DOM
                  // classifier defers those to editable targets.
                  iframeFallbackEligible: iframeShortcutFallbackActive
                      && event.modifierFlags.contains(.command)
              )
        else {
            return false
        }
        let handled = shortcutKey.withCString { key in
            nativeSupportDidReceiveAppShortcut(
                key,
                event.modifierFlags.contains(.shift) ? 1 : 0,
                event.modifierFlags.contains(.control) ? 1 : 0,
                event.modifierFlags.contains(.option) ? 1 : 0,
                event.modifierFlags.contains(.command) ? 1 : 0,
                event.isARepeat ? 1 : 0
            ) == 1
        }
        if handled {
            consumedAppShortcutKeyCodes.insert(event.keyCode)
        }
        return handled
    }

    private func webAppShortcutResponderState(
        in window: NSWindow
    ) -> WebAppShortcutResponderState {
        guard let responder = window.firstResponder as? NSView else {
            return .outsideWebView
        }
        if let humanBrowserWebView,
           responder === humanBrowserWebView
               || responder.isDescendant(of: humanBrowserWebView)
        {
            return .humanBrowser
        }
        if responder is WKWebView {
            return .outerWebView
        }
        return isInWebView(responder) ? .webViewDescendant : .outsideWebView
    }

    private func appShortcutKey(for event: NSEvent) -> String? {
        // Match React's physical-code handling for Cmd-backtick. WebKit may
        // expose this key as Dead or a composed character after focus churn,
        // while the ANSI key code remains stable.
        if event.keyCode == 50 {
            return "`"
        }
        guard let key = event.charactersIgnoringModifiers?.lowercased() else {
            return nil
        }
        return webShortcutKey(for: key)
    }

    private func webShortcutKey(for key: String) -> String? {
        switch key {
        case "\r": return "Enter"
        case "\t", "\u{19}": return "Tab"
        case "\u{1b}": return "Escape"
        case "\u{7f}": return "Backspace"
        case "\u{F700}": return "ArrowUp"
        case "\u{F701}": return "ArrowDown"
        case "\u{F702}": return "ArrowLeft"
        case "\u{F703}": return "ArrowRight"
        default:
            guard let scalar = key.unicodeScalars.first,
                  key.unicodeScalars.count == 1,
                  scalar.value >= 0x20,
                  // Function keys land in the Unicode private use area.
                  scalar.value < 0xF700
            else {
                return nil
            }
            return key
        }
    }

    private func routeEvent(_ event: NSEvent) -> NSEvent? {
        guard let window, event.window === window else { return event }
        if event.type == .keyUp {
            return consumedAppShortcutKeyCodes.remove(event.keyCode) == nil ? event : nil
        }
        guard event.type == .keyDown else { return event }
        if !event.isARepeat { consumedAppShortcutKeyCodes.remove(event.keyCode) }
        let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if shouldClaimBrowserEscape(
            browserOverlayOpen: browserOverlayOpen,
            key: event.charactersIgnoringModifiers,
            control: modifiers.contains(.control),
            option: modifiers.contains(.option),
            command: modifiers.contains(.command)
        ), nativeSupportDidRequestBrowserEscape() == 1 {
            consumedAppShortcutKeyCodes.insert(event.keyCode)
            return nil
        }
        return claimWebAppShortcut(event) ? nil : event
    }
}
