// swift-tools-version:5.9
import PackageDescription

// unmute-notch — the native macOS notch surface for Unmute.
//
// A standalone SwiftUI/AppKit executable that Electron main spawns and drives
// over line-delimited JSON on stdin/stdout (IPC.swift). One always-present,
// non-activating NSPanel morphs through six states (dormant → cockpit); the
// full cockpit renders natively inside it — no separate window.
//
// SwiftTerm provides the real terminal emulator (the live PTY view) — the same
// class of component xterm.js was in the web cockpit. Pinned to a release range
// for reproducible builds.
//
// swift-markdown is Apple's own cmark-gfm binding — the SAME C engine GitHub
// parses with. Agent answers arrive as ordinary markdown, and the hand-rolled
// line-classifier this replaced could not see tables at all: a pipe table came
// out as literal `|` rows. Two hand-rolled renderers (this one and the
// dashboard's) had each grown a DIFFERENT half of CommonMark, which is the
// argument for parsing with something real rather than extending either.
let package = Package(
    name: "unmute-notch",
    platforms: [
        .macOS(.v13)
    ],
    dependencies: [
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", from: "1.2.0"),
        .package(url: "https://github.com/apple/swift-markdown.git", from: "0.8.0")
    ],
    targets: [
        .target(
            name: "SurfaceTransitionSupport",
            path: "Sources/SurfaceTransitionSupport"
        ),
        .target(
            name: "SurfaceStateSupport",
            path: "Sources/SurfaceStateSupport"
        ),
        .testTarget(
            name: "SurfaceStateSupportTests",
            dependencies: ["SurfaceStateSupport"],
            path: "Tests/SurfaceStateSupportTests"
        ),
        .testTarget(
            name: "SurfaceTransitionSupportTests",
            dependencies: ["SurfaceTransitionSupport"],
            path: "Tests/SurfaceTransitionSupportTests"
        ),
        .target(
            name: "SurfaceSizeSupport",
            path: "Sources/SurfaceSizeSupport"
        ),
        .testTarget(
            name: "SurfaceSizeSupportTests",
            dependencies: ["SurfaceSizeSupport"],
            path: "Tests/SurfaceSizeSupportTests"
        ),
        .target(
            name: "ComposerSupport",
            path: "Sources/ComposerSupport"
        ),
        .testTarget(
            name: "ComposerSupportTests",
            dependencies: ["ComposerSupport"],
            path: "Tests/ComposerSupportTests"
        ),
        .target(
            name: "HoverStateSupport",
            path: "Sources/HoverStateSupport"
        ),
        .testTarget(
            name: "HoverStateSupportTests",
            dependencies: ["HoverStateSupport"],
            path: "Tests/HoverStateSupportTests"
        ),
        // The Theme-free half of markdown rendering, split out ONLY so it can be
        // tested: the executable target imports SwiftUI and cannot be imported
        // by a test target. Anything that needs `Theme` stays in the executable,
        // which keeps this dependency-free and the dependency arrow one-way.
        .target(
            name: "MarkdownSupport",
            path: "Sources/MarkdownSupport"
        ),
        .testTarget(
            name: "MarkdownSupportTests",
            dependencies: ["MarkdownSupport"],
            path: "Tests/MarkdownSupportTests"
        ),
        .executableTarget(
            name: "unmute-notch",
            dependencies: [
                .product(name: "SwiftTerm", package: "SwiftTerm"),
                .product(name: "Markdown", package: "swift-markdown"),
                "MarkdownSupport",
                "HoverStateSupport",
                "ComposerSupport",
                "SurfaceSizeSupport",
                "SurfaceTransitionSupport",
                "SurfaceStateSupport"
            ],
            path: "Sources/unmute-notch"
        )
    ]
)
