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

@MainActor
private enum CompletionSoundPlayer {
    private static var soundsByName: [String: NSSound] = [:]

    static func play(systemName: String) -> Bool {
        play(cacheKey: "system:\(systemName)") {
            NSSound(named: NSSound.Name(systemName))
        }
    }

    static func play(systemPath: String) -> Bool {
        play(cacheKey: "system-file:\(systemPath)") {
            NSSound(contentsOfFile: systemPath, byReference: true)
        }
    }

    static func play(name: String, data: Data) -> Bool {
        play(cacheKey: "bundled:\(name)") {
            NSSound(data: data)
        }
    }

    private static func play(cacheKey: String, load: () -> NSSound?) -> Bool {
        let sound: NSSound
        if let cached = soundsByName[cacheKey] {
            sound = cached
        } else {
            guard let loaded = load() else {
                return false
            }
            soundsByName[cacheKey] = loaded
            sound = loaded
        }
        sound.stop()
        return sound.play()
    }
}

@_cdecl("qmux_native_completion_sound_play")
public func qmuxNativeCompletionSoundPlay(
    _ systemName: UnsafePointer<CChar>?
) -> Int32 {
    guard let systemName = supportString(systemName) else {
        return 0
    }
    return onSupportMain {
        CompletionSoundPlayer.play(systemName: systemName) ? 1 : 0
    }
}

@_cdecl("qmux_native_completion_sound_play_file")
public func qmuxNativeCompletionSoundPlayFile(
    _ systemPath: UnsafePointer<CChar>?
) -> Int32 {
    guard let systemPath = supportString(systemPath) else {
        return 0
    }
    return onSupportMain {
        CompletionSoundPlayer.play(systemPath: systemPath) ? 1 : 0
    }
}

@_cdecl("qmux_native_completion_sound_play_data")
public func qmuxNativeCompletionSoundPlayData(
    _ name: UnsafePointer<CChar>?,
    _ bytes: UnsafePointer<UInt8>?,
    _ length: Int
) -> Int32 {
    guard let name = supportString(name), let bytes, length > 0 else {
        return 0
    }
    let data = Data(bytes: bytes, count: length)
    return onSupportMain {
        CompletionSoundPlayer.play(name: name, data: data) ? 1 : 0
    }
}

@_cdecl("qmux_native_application_is_active")
public func qmuxNativeApplicationIsActive() -> Int32 {
    onSupportMain {
        NSApp.isActive ? 1 : 0
    }
}

@_cdecl("qmux_native_terminal_initialize")
public func qmuxNativeTerminalInitialize(
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

@_cdecl("qmux_native_terminal_set_iframe_shortcut_fallback")
public func qmuxNativeTerminalSetIframeShortcutFallback(_ active: Int32) -> Int32 {
    onSupportMain {
        NativeSupportHost.shared.setIframeShortcutFallback(active == 1) ? 1 : 0
    }
}

@_cdecl("qmux_native_terminal_set_browser_overlay_open")
public func qmuxNativeTerminalSetBrowserOverlayOpen(_ active: Int32) -> Int32 {
    onSupportMain {
        NativeSupportHost.shared.setBrowserOverlayOpen(active == 1) ? 1 : 0
    }
}

@_cdecl("qmux_native_terminal_set_human_browser_webview")
public func qmuxNativeTerminalSetHumanBrowserWebView(
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

@_cdecl("qmux_native_terminal_set_human_browser_loading_background")
public func qmuxNativeTerminalSetHumanBrowserLoadingBackground(
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

@_cdecl("qmux_native_terminal_human_browser_history_state")
public func qmuxNativeTerminalHumanBrowserHistoryState(
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

@_cdecl("qmux_native_terminal_prepare_for_webview_reload")
public func qmuxNativeTerminalPrepareForWebViewReload() -> Int32 {
    onSupportMain {
        NativeSupportHost.shared.prepareForWebViewReload() ? 1 : 0
    }
}

@_cdecl("qmux_native_terminal_shutdown")
public func qmuxNativeTerminalShutdown() {
    onSupportMain {
        NativeSupportHost.shared.shutdown()
    }
}

@_cdecl("qmux_native_terminal_bridge_available")
public func qmuxNativeTerminalBridgeAvailable() -> Int32 { 1 }

@_cdecl("qmux_native_support_set_browser_background")
public func qmuxNativeSupportSetBrowserBackground(_ red: Double, _ green: Double, _ blue: Double) -> Int32 {
    onSupportMain {
        NativeSupportHost.shared.setBrowserBackground(red: red, green: green, blue: blue) ? 1 : 0
    }
}
