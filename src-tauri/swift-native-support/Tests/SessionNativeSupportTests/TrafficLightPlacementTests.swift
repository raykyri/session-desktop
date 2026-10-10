import AppKit
import XCTest
@testable import SessionNativeSupport

final class TrafficLightPlacementTests: XCTestCase {
    @MainActor
    private func makeWindow() -> NSWindow {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 960, height: 640),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        return window
    }

    @MainActor
    private func centre(of button: NSButton, in window: NSWindow) -> NSPoint {
        let frame = button.convert(button.bounds, to: nil)
        return NSPoint(x: frame.midX, y: window.frame.height - frame.midY)
    }

    @MainActor
    func testButtonsAlignWithHeaderRowAndPreserveSystemSpacing() throws {
        let window = makeWindow()
        let close = try XCTUnwrap(window.standardWindowButton(.closeButton))
        let miniaturize = try XCTUnwrap(window.standardWindowButton(.miniaturizeButton))
        let systemSpacing = miniaturize.frame.minX - close.frame.minX
        let placement = TrafficLightPlacement()
        defer { placement.detach() }

        placement.attach(to: window)

        XCTAssertEqual(close.convert(close.bounds, to: nil).minX, TrafficLightPlacement.leading, accuracy: 0.5)
        XCTAssertEqual(centre(of: close, in: window).y, TrafficLightPlacement.centerY, accuracy: 0.5)
        XCTAssertEqual(centre(of: miniaturize, in: window).y, TrafficLightPlacement.centerY, accuracy: 0.5)
        XCTAssertEqual(miniaturize.frame.minX - close.frame.minX, systemSpacing, accuracy: 0.5)
    }

    @MainActor
    func testPlacementIsReappliedAfterTheWindowResizes() throws {
        let window = makeWindow()
        let close = try XCTUnwrap(window.standardWindowButton(.closeButton))
        let placement = TrafficLightPlacement()
        defer { placement.detach() }
        placement.attach(to: window)

        window.setFrame(NSRect(x: 0, y: 0, width: 1200, height: 800), display: false)
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))

        XCTAssertEqual(close.convert(close.bounds, to: nil).minX, TrafficLightPlacement.leading, accuracy: 0.5)
        XCTAssertEqual(centre(of: close, in: window).y, TrafficLightPlacement.centerY, accuracy: 0.5)
    }
}
