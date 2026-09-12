import Foundation

// Test-only definitions of callbacks provided by Rust in the app.
@_cdecl("qmux_native_terminal_did_receive_app_shortcut")
func nativeTerminalDidReceiveAppShortcutStub(
    _: UnsafePointer<CChar>,
    _: Int32,
    _: Int32,
    _: Int32,
    _: Int32,
    _: Int32
) -> Int32 {
    0
}

@_cdecl("qmux_native_terminal_did_request_browser_escape")
func nativeTerminalDidRequestBrowserEscapeStub() -> Int32 {
    0
}

@_cdecl("qmux_native_terminal_did_begin_interface_health_check")
func nativeTerminalDidBeginInterfaceHealthCheckStub() -> UInt64 {
    0
}

@_cdecl("qmux_native_terminal_did_cancel_interface_health_check")
func nativeTerminalDidCancelInterfaceHealthCheckStub() {}

@_cdecl("qmux_native_terminal_did_detect_unhealthy_webview")
func nativeTerminalDidDetectUnhealthyWebViewStub(_: UInt64) {}

@_cdecl("qmux_native_terminal_system_sleep_changed")
func testSystemSleepChanged(_ sleeping: Int32) {}
