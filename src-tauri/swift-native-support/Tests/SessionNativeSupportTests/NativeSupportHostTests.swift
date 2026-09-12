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
        XCTAssertEqual(color?.redComponent ?? -1, 0.1, accuracy: 0.001)
        XCTAssertTrue(host.setHumanBrowserLoadingBackground(webView, active: false))
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
