import SwiftUI
import WebKit

/// THE SANDBOX. Everything untrusted about a canvas is contained here; the card
/// above it is only chrome. See the header of CanvasCard.swift for why each of
/// these exists — this file is where the claims are actually made true.
struct CanvasWeb: NSViewRepresentable {
    let format: String
    let source: String
    /// The conversation's content width, in points. A resize re-lays out rather
    /// than rescaling, so text in a diagram stays crisp and correctly wrapped.
    let width: CGFloat
    @Binding var height: CGFloat
    @Binding var failure: String?

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        // NOTHING SURVIVES THE CARD. A canvas has no business keeping state
        // between renders, and an ephemeral store means localStorage cannot
        // accumulate across a long conversation.
        config.websiteDataStore = .nonPersistent()
        config.suppressesIncrementalRendering = true
        // SCRIPTS ONLY FOR THE INTERACTIVE FORMAT. Mermaid ships its own
        // renderer (which needs JS) and `html` is interactive by definition;
        // an SVG needs none, so it does not get any. The measurement script
        // below runs regardless — it is ours, injected at a different world.
        if #available(macOS 14.0, *) {
            config.defaultWebpagePreferences.allowsContentJavaScript = format != "svg"
        }
        // THE HEIGHT REPORTER, in the page's own world because it has to read
        // the laid-out document. It is added as a user script rather than
        // appended to the agent's markup so a syntactically broken drawing
        // cannot break the measurement too.
        let reporter = WKUserScript(source: Self.measureScript,
                                    injectionTime: .atDocumentEnd,
                                    forMainFrameOnly: true)
        config.userContentController.addUserScript(reporter)
        config.userContentController.add(context.coordinator, name: "canvas")

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        // The card draws the background; a white webview would flash on every
        // load and read as a hole in a dark panel.
        web.setValue(false, forKey: "drawsBackground")
        web.allowsBackForwardNavigationGestures = false
        // No rubber-banding: the card is sized to the content, so an inner
        // bounce would look like the conversation itself had come loose.
        web.enclosingScrollView?.verticalScrollElasticity = .none
        context.coordinator.load(web, html: document)
        return web
    }

    func updateNSView(_ web: WKWebView, context: Context) {
        context.coordinator.parent = self
        // Reload only when the DRAWING changed, never on an ordinary SwiftUI
        // pass — a reload on every layout would restart animations and blink.
        // Width changes are handled by CSS, not by reloading.
        context.coordinator.load(web, html: document)
    }

    // MARK: - The document

    /// The agent's source, wrapped in exactly the policy it is allowed.
    ///
    /// The CSP is FIRST, before any of the agent's markup, because a policy
    /// that arrives after a `<script src>` has already been parsed is not a
    /// policy. `default-src 'none'` is the deny-all base; each allowance below
    /// is opened deliberately and no allowance permits a remote origin.
    private var document: String {
        let csp = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:;"
            + (format == "svg" ? "" : " script-src 'unsafe-inline';")
        // Both formats are their own document body. SVG is inlined rather than
        // put in an <img>, so it inherits the page's colours and can be sized
        // by CSS; an <img src="data:…"> would be an opaque bitmap that ignores
        // the panel's width.
        let body = source
        return """
        <!doctype html><html><head><meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="\(csp)">
        <style>
          :root { color-scheme: dark; }
          html, body { margin:0; padding:0; background:transparent; }
          body { color:#e8e6e1; font:13px/1.5 -apple-system, system-ui, sans-serif;
                 padding:12px; box-sizing:border-box; overflow-x:auto; overflow-y:hidden; }
          /* The drawing must live inside the card's width at any panel size. */
          svg, img, canvas, table { max-width:100%; height:auto; }
          a { color:#7aa7ff; }
          /* A lone <svg> centres itself; a page lays itself out. */
          body > svg { display:block; margin:0 auto; }
        </style></head><body>\(body)</body></html>
        """
    }

    /// Reports the laid-out height, once settled and on every later change.
    ///
    /// A ResizeObserver rather than a one-shot read: mermaid lays out
    /// asynchronously, web fonts settle late, and an interactive canvas can
    /// grow when a button is pressed. A single measurement at load would be
    /// correct for none of those.
    private static let measureScript = """
    (function () {
      var last = 0;
      function send() {
        var h = Math.ceil(document.documentElement.scrollHeight);
        if (h === last) return;
        last = h;
        window.webkit.messageHandlers.canvas.postMessage({ type: 'height', value: h });
      }
      window.__canvasMeasure = send;
      if (window.ResizeObserver) new ResizeObserver(send).observe(document.documentElement);
      window.addEventListener('load', send);
      document.addEventListener('DOMContentLoaded', send);
      setTimeout(send, 40); setTimeout(send, 300);
    })();
    """

    // MARK: - Coordinator

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var parent: CanvasWeb
        /// What is currently loaded, so an ordinary SwiftUI update does not
        /// reload the document and restart everything in it.
        private var loaded: String?

        init(_ parent: CanvasWeb) { self.parent = parent }

        func load(_ web: WKWebView, html: String) {
            guard loaded != html else { return }
            loaded = html
            // baseURL nil ⇒ an opaque origin. Even an absolute file:// path in
            // the agent's markup resolves to nothing.
            web.loadHTMLString(html, baseURL: nil)
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any] else { return }
            switch body["type"] as? String {
            case "height":
                guard let value = body["value"] as? Double, value > 0 else { return }
                // Clamped here as well as in the card: a document that reports
                // a runaway height would otherwise animate the whole panel.
                let next = min(max(CGFloat(value), 40), CanvasMetrics.expandedMax)
                if abs(next - parent.height) > 1 { parent.height = next }
            case "failure":
                parent.failure = (body["message"] as? String).map { "This diagram could not be drawn — \($0)" }
                    ?? "This diagram could not be drawn."
            default:
                break
            }
        }

        /// EVERY NAVIGATION IS REFUSED except the initial load of our own
        /// document. A link in a drawing opens in the user's own browser, which
        /// is where a web page belongs — the conversation is not a browser and
        /// must not become one.
        func webView(_ web: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if action.navigationType == .other && action.request.url == nil {
                decisionHandler(.allow); return
            }
            if let url = action.request.url, url.absoluteString == "about:blank" {
                decisionHandler(.allow); return
            }
            if action.navigationType == .linkActivated, let url = action.request.url,
               url.scheme == "https" || url.scheme == "http" {
                NSWorkspace.shared.open(url)
            }
            decisionHandler(.cancel)
        }

        func webView(_ web: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            parent.failure = "This drawing could not be shown."
        }

        /// No popups, no alerts. A canvas that calls `alert()` would otherwise
        /// put a modal over the whole app.
        func webView(_ web: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }

        func webView(_ web: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            completionHandler()
        }
    }
}
