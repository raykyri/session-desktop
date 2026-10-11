import AppKit
import WebKit
import XCTest
@testable import SessionNativeSupport

/// Serves a fixed set of pages with headers for a custom scheme, so a test can
/// load a cross-origin, CSP-carrying page into a sandboxed frame.
@MainActor
private final class FixedPageSchemeHandler: NSObject, @preconcurrency WKURLSchemeHandler {
    private let pages: [String: (headers: [String: String], body: String)]

    init(pages: [String: (headers: [String: String], body: String)]) {
        self.pages = pages
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url,
              let page = pages["\(url.host ?? "")\(url.path)"],
              let response = HTTPURLResponse(
                  url: url,
                  statusCode: 200,
                  httpVersion: "HTTP/1.1",
                  headerFields: page.headers.merging(["Content-Type": "text/html; charset=utf-8"]) { $1 }
              )
        else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(Data(page.body.utf8))
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {}
}

/// Proves that the app web view's peer-connection preference covers the realms
/// an answer widget can reach: the widget page itself (cross-origin, sandboxed
/// `allow-scripts` without `allow-same-origin`, served under the widget run
/// page's CSP but without Session's RTC-deleting prelude) and a srcdoc child it
/// creates, which CSP does not block and the prelude cannot reach. A blob: child
/// is expected to be blocked by the CSP. A control web view without the
/// preference change shows the probe can detect WebRTC at all.
///
/// Answer widget scripts (Run) must not ship unless this test passes on a Mac:
/// no other check shows that the preference reaches the srcdoc realm.
final class WidgetPeerConnectionTests: XCTestCase {
    /// Same directives as `widget_csp` in src-tauri/src/file_server.rs for the
    /// run page, minus the file-server font origin.
    private static let runPageCSP =
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
        + "img-src data: blob:; media-src data: blob:; connect-src 'none'; object-src 'none'; "
        + "base-uri 'none'; form-action 'none'; sandbox allow-scripts"

    /// Reports `typeof RTCPeerConnection` in its realm and, when a constructor
    /// exists, how many ICE candidates an offer gathers (no ICE servers, so
    /// only local host candidates; nothing leaves the machine).
    private static let probe = """
        function probe(where, target) {
          const C = window.RTCPeerConnection;
          const report = (x) => target.postMessage(Object.assign({ where }, x), "*");
          if (typeof C !== "function") { report({ rtc: typeof C }); return; }
          try {
            const pc = new C({ iceServers: [] });
            let n = 0;
            pc.onicecandidate = (e) => { if (e.candidate) n++; };
            pc.createDataChannel("d");
            pc.createOffer().then((o) => pc.setLocalDescription(o)).then(
              () => setTimeout(() => report({ rtc: "function", candidates: n }), 1500),
              (e) => report({ rtc: "function", error: String(e) }));
          } catch (e) { report({ rtc: "function", error: String(e) }); }
        }
        """

    private static let widgetRunPage = """
        <!doctype html><html><head><meta charset="utf-8"></head><body><p>widget</p>
        <script>
        \(probe)
        probe("widget", parent);
        const child = document.createElement("iframe");
        child.srcdoc = "<script>(" + probe + ")('srcdoc', parent.parent)<\\/script>";
        document.body.appendChild(child);
        const blob = new Blob(["<script>(" + probe + ")('blob', parent.parent)<\\/script>"], { type: "text/html" });
        const blobChild = document.createElement("iframe");
        blobChild.src = URL.createObjectURL(blob);
        document.body.appendChild(blobChild);
        </script></body></html>
        """

    private static let appPage = """
        <!doctype html><html><body>
        <script>window.results = []; addEventListener("message", (e) => { if (e.data && e.data.where) results.push(e.data); });</script>
        <iframe sandbox="allow-scripts" src="sessiontest://widget/run.html"></iframe>
        </body></html>
        """

    @MainActor
    private func makeWebView() -> WKWebView {
        let handler = FixedPageSchemeHandler(pages: [
            "app/index.html": (headers: [:], body: Self.appPage),
            "widget/run.html": (headers: ["Content-Security-Policy": Self.runPageCSP], body: Self.widgetRunPage),
        ])
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(handler, forURLScheme: "sessiontest")
        return WKWebView(frame: NSRect(x: 0, y: 0, width: 640, height: 480), configuration: configuration)
    }

    /// Loads the app page and waits until the widget and srcdoc realms have
    /// reported (the blob child normally never does: CSP blocks it).
    @MainActor
    private func results(in webView: WKWebView) async throws -> [[String: Any]] {
        webView.load(URLRequest(url: URL(string: "sessiontest://app/index.html")!))
        var reports: [[String: Any]] = []
        for _ in 0..<40 {
            try await Task.sleep(nanoseconds: 250_000_000)
            let json = try await webView.evaluateJavaScript("JSON.stringify(window.results || [])") as? String
            let data = Data((json ?? "[]").utf8)
            reports = (try JSONSerialization.jsonObject(with: data) as? [[String: Any]]) ?? []
            let realms = Set(reports.compactMap { $0["where"] as? String })
            if realms.isSuperset(of: ["widget", "srcdoc"]) {
                // Give a blob child that was not blocked time to report too.
                try await Task.sleep(nanoseconds: 2_000_000_000)
                let later = try await webView.evaluateJavaScript("JSON.stringify(window.results || [])") as? String
                return (try JSONSerialization.jsonObject(with: Data((later ?? "[]").utf8)) as? [[String: Any]]) ?? reports
            }
        }
        return reports
    }

    @MainActor
    func testPeerConnectionPreferenceCoversTheWidgetRealmAndItsSrcdocChild() async throws {
        // Control: an ordinary web view exposes WebRTC to the same widget page,
        // so the assertions below are about the preference, not the sandbox.
        let control = makeWebView()
        let controlReports = try await results(in: control)
        let controlWidget = controlReports.first { $0["where"] as? String == "widget" }
        guard controlWidget?["rtc"] as? String == "function" else {
            XCTFail("the control web view exposes no RTCPeerConnection to a sandboxed frame (\(controlReports)); this test cannot show the preference's effect here")
            return
        }

        let host = NativeSupportHost.shared
        defer { host.shutdown() }
        let webView = makeWebView()
        XCTAssertTrue(host.attach(to: webView))
        XCTAssertTrue(host.disablePeerConnections())
        let reports = try await results(in: webView)
        let byRealm = Dictionary(
            reports.compactMap { report in (report["where"] as? String).map { ($0, report) } },
            uniquingKeysWith: { first, _ in first }
        )
        XCTAssertEqual(byRealm["widget"]?["rtc"] as? String, "undefined", "\(reports)")
        XCTAssertEqual(byRealm["srcdoc"]?["rtc"] as? String, "undefined", "\(reports)")
        // The blob child is expected to be refused by the CSP; if it ever loads,
        // it must not have WebRTC either.
        if let blob = byRealm["blob"] {
            XCTAssertEqual(blob["rtc"] as? String, "undefined", "\(reports)")
        }
        XCTAssertFalse(reports.contains { ($0["candidates"] as? Int ?? 0) > 0 }, "\(reports)")
    }
}
