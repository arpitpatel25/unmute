// swift-tools-version:5.9
import PackageDescription

// unmute-notch — the native macOS notch shell for Unmute.
//
// A standalone SwiftUI/AppKit executable that Electron main spawns and drives
// over line-delimited JSON on stdin/stdout (see IPC.swift). It owns a
// non-activating NSPanel pinned at the notch and renders the 4-state shell
// (idle / peek / attention panel), never stealing focus. The full cockpit stays
// an Electron window — this helper only asks Electron to show it.
let package = Package(
    name: "unmute-notch",
    platforms: [
        .macOS(.v13)
    ],
    targets: [
        .executableTarget(
            name: "unmute-notch",
            path: "Sources/unmute-notch"
        )
    ]
)
