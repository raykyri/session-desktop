import AppKit
import WebKit
import XCTest
@testable import SessionNativeSupport

final class NativeSupportHostTests: XCTestCase {
    @MainActor
    func testWindowlessAttachReloadAndShutdownDoNotNeedATerminalContainer() {
        let host = NativeSupportHost.shared
        defer { host.shutdown() }
        let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 320, height: 240))
        XCTAssertTrue(host.attach(to: webView))
        XCTAssertTrue(host.setBrowserOverlayOpen(true))
        XCTAssertTrue(host.setIframeShortcutFallback(true))
        XCTAssertTrue(host.prepareForWebViewReload())
        XCTAssertTrue(host.attach(to: webView))
        host.shutdown()
        XCTAssertFalse(host.setBrowserOverlayOpen(true))
        XCTAssertFalse(host.setIframeShortcutFallback(true))
        XCTAssertFalse(host.prepareForWebViewReload())
    }

    @MainActor
    func testLoadingBackgroundUsesAppAppearanceAndClearsAfterLoad() {
        let host = NativeSupportHost.shared
        defer { host.shutdown() }
        let webView = WKWebView(frame: .zero)
        XCTAssertFalse(host.setBrowserBackground(red: .nan, green: 0, blue: 0))
        XCTAssertFalse(host.setBrowserBackground(red: -1, green: 0, blue: 0))
        XCTAssertTrue(host.setBrowserBackground(red: 0.1, green: 0.2, blue: 0.3))
        XCTAssertTrue(host.setHumanBrowserLoadingBackground(webView, active: true))
        let color = webView.underPageBackgroundColor.usingColorSpace(.sRGB)
        // WebKit stores the colour with 8 bits per component (0.1 reads back
        // as 26/255 ≈ 0.10196), so allow one step of that quantisation.
        XCTAssertEqual(color?.redComponent ?? -1, 0.1, accuracy: 1.0 / 255)
        XCTAssertTrue(host.setHumanBrowserLoadingBackground(webView, active: false))
    }

    @MainActor
    func testPeerConnectionsAreDisabledForTheAppWebViewOnly() {
        let host = NativeSupportHost.shared
        defer { host.shutdown() }
        let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 320, height: 240))
        let other = WKWebView(frame: .zero)
        XCTAssertFalse(host.disablePeerConnections(), "no app web view attached")
        XCTAssertTrue(host.attach(to: webView))
        XCTAssertTrue(host.disablePeerConnections())

        let getter = NSSelectorFromString("_peerConnectionEnabled")
        typealias Getter = @convention(c) (AnyObject, Selector) -> ObjCBool
        func enabled(_ view: WKWebView) -> Bool {
            let preferences = view.configuration.preferences
            return unsafeBitCast(preferences.method(for: getter), to: Getter.self)(preferences, getter).boolValue
        }
        XCTAssertFalse(enabled(webView))
        XCTAssertTrue(enabled(other), "other web views keep their own preferences")

        // Frames loaded afterwards, including about:blank children, have no
        // RTCPeerConnection constructor.
        let loaded = expectation(description: "page evaluated")
        webView.loadHTMLString("<iframe></iframe>", baseURL: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            webView.evaluateJavaScript(
                "[typeof RTCPeerConnection, typeof webkitRTCPeerConnection, typeof frames[0].RTCPeerConnection].join()"
            ) { result, error in
                XCTAssertNil(error)
                XCTAssertEqual(result as? String, "undefined,undefined,undefined")
                loaded.fulfill()
            }
        }
        wait(for: [loaded], timeout: 10)
    }

    @MainActor
    func testInvalidReattachmentInvalidatesPreviousHost() {
        let host = NativeSupportHost.shared
        defer { host.shutdown() }
        let webView = WKWebView(frame: .zero)
        XCTAssertTrue(host.attach(to: webView))
        XCTAssertFalse(host.attach(to: NSView(frame: .zero)))
        XCTAssertFalse(host.setBrowserOverlayOpen(true))
    }
}
