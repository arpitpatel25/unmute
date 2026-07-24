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
let package = Package(
    name: "unmute-notch",
    platforms: [
        .macOS(.v13)
    ],
    dependencies: [
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", from: "1.2.0")
    ],
    targets: [
        .executableTarget(
            name: "unmute-notch",
            dependencies: [
                .product(name: "SwiftTerm", package: "SwiftTerm")
            ],
            path: "Sources/unmute-notch"
        )
    ]
)
