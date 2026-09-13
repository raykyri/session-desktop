import AppKit
import CoreGraphics
import Foundation
import WebKit

private func supportString(_ pointer: UnsafePointer<CChar>?) -> String? {
    guard let pointer else { return nil }
    return String(cString: pointer)
}

private func onSupportMain<T: Sendable>(
    _ operation: @escaping @MainActor () -> T
) -> T {
    if Thread.isMainThread {
        return MainActor.assumeIsolated {
            operation()
        }
    }
    return DispatchQueue.main.sync {
        MainActor.assumeIsolated {
            operation()
        }
    }
}

@_cdecl("session_native_application_is_active")
public func sessionNativeApplicationIsActive() -> Int32 {
    onSupportMain {
        NSApp.isActive ? 1 : 0
    }
}

@_cdecl("session_native_support_initialize")
public func sessionNativeSupportInitialize(
    _ nativeView: UnsafeMutableRawPointer?
) -> Int32 {
    guard let nativeView else { return 0 }
    let nativeViewAddress = UInt(bitPattern: nativeView)
    return onSupportMain {
        guard let nativeView = UnsafeMutableRawPointer(
            bitPattern: nativeViewAddress
        ) else {
            return 0
        }
        let view = Unmanaged<NSView>.fromOpaque(nativeView).takeUnretainedValue()
        return NativeSupportHost.shared.attach(to: view) ? 1 : 0
    }
}

@_cdecl("session_native_support_set_iframe_shortcut_fallback")
public func sessionNativeSupportSetIframeShortcutFallback(_ active: Int32) -> Int32 {
    onSupportMain {
        NativeSupportHost.shared.setIframeShortcutFallback(active == 1) ? 1 : 0
    }
}

@_cdecl("session_native_support_set_browser_overlay_open")
public func sessionNativeSupportSetBrowserOverlayOpen(_ active: Int32) -> Int32 {
    onSupportMain {
        NativeSupportHost.shared.setBrowserOverlayOpen(active == 1) ? 1 : 0
    }
}

@_cdecl("session_native_support_set_human_browser_webview")
public func sessionNativeSupportSetHumanBrowserWebView(
    _ nativeView: UnsafeMutableRawPointer?,
    _ active: Int32
) -> Int32 {
    let nativeViewAddress = nativeView.map(UInt.init(bitPattern:))
    return onSupportMain {
        let webView = nativeViewAddress.flatMap {
            UnsafeMutableRawPointer(bitPattern: $0)
        }.map {
            Unmanaged<WKWebView>.fromOpaque($0).takeUnretainedValue()
        }
        return NativeSupportHost.shared.setHumanBrowserWebView(
            webView,
            active: active == 1
        ) ? 1 : 0
    }
}

@_cdecl("session_native_support_set_human_browser_loading_background")
public func sessionNativeSupportSetHumanBrowserLoadingBackground(
    _ nativeView: UnsafeMutableRawPointer?,
    _ active: Int32
) -> Int32 {
    let nativeViewAddress = nativeView.map(UInt.init(bitPattern:))
    return onSupportMain {
        let webView = nativeViewAddress.flatMap {
            UnsafeMutableRawPointer(bitPattern: $0)
        }.map {
            Unmanaged<WKWebView>.fromOpaque($0).takeUnretainedValue()
        }
        return NativeSupportHost.shared.setHumanBrowserLoadingBackground(
            webView,
            active: active == 1
        ) ? 1 : 0
    }
}

@_cdecl("session_native_support_human_browser_history_state")
public func sessionNativeSupportHumanBrowserHistoryState(
    _ nativeView: UnsafeMutableRawPointer?
) -> Int32 {
    let nativeViewAddress = nativeView.map(UInt.init(bitPattern:))
    return onSupportMain {
        guard let webView = nativeViewAddress.flatMap({
            UnsafeMutableRawPointer(bitPattern: $0)
        }).map({
            Unmanaged<WKWebView>.fromOpaque($0).takeUnretainedValue()
        }) else {
            return 0
        }
        return (webView.canGoBack ? 1 : 0) | (webView.canGoForward ? 2 : 0)
    }
}

@_cdecl("session_native_support_prepare_for_webview_reload")
public func sessionNativeSupportPrepareForWebViewReload() -> Int32 {
    onSupportMain {
        NativeSupportHost.shared.prepareForWebViewReload() ? 1 : 0
    }
}

@_cdecl("session_native_support_shutdown")
public func sessionNativeSupportShutdown() {
    onSupportMain {
        NativeSupportHost.shared.shutdown()
    }
}

@_cdecl("session_native_support_bridge_available")
public func sessionNativeSupportBridgeAvailable() -> Int32 { 1 }

@_cdecl("session_native_support_set_browser_background")
public func sessionNativeSupportSetBrowserBackground(_ red: Double, _ green: Double, _ blue: Double) -> Int32 {
    onSupportMain {
        NativeSupportHost.shared.setBrowserBackground(red: red, green: green, blue: blue) ? 1 : 0
    }
}
