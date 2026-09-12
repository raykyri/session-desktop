import Foundation

// Test-only definitions of callbacks provided by Rust in the app.
@_cdecl("session_native_support_did_receive_app_shortcut")
func nativeSupportDidReceiveAppShortcutStub(
    _: UnsafePointer<CChar>,
    _: Int32,
    _: Int32,
    _: Int32,
    _: Int32,
    _: Int32
) -> Int32 {
    0
}

@_cdecl("session_native_support_did_request_browser_escape")
func nativeSupportDidRequestBrowserEscapeStub() -> Int32 {
    0
}

@_cdecl("session_native_support_did_begin_interface_health_check")
func nativeSupportDidBeginInterfaceHealthCheckStub() -> UInt64 {
    0
}

@_cdecl("session_native_support_did_cancel_interface_health_check")
func nativeSupportDidCancelInterfaceHealthCheckStub() {}

@_cdecl("session_native_support_did_detect_unhealthy_webview")
func nativeSupportDidDetectUnhealthyWebViewStub(_: UInt64) {}

@_cdecl("session_native_support_system_sleep_changed")
func testSystemSleepChanged(_ sleeping: Int32) {}
