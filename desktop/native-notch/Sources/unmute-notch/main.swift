import AppKit

// Entry point. Runs as an .accessory app (no Dock icon, never becomes active,
// so it can never steal focus from the user's foreground app). Stdin is read on
// a background thread; decoded commands are dispatched to AppController on the
// main queue. Stdout carries events back to Electron main.

NotchLog.log("=== unmute-notch launch === pid=\(ProcessInfo.processInfo.processIdentifier)")

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let controller = AppController()

IPC.startReadLoop { command in
    controller.handle(command)
}

// Never outlive the app. stdin EOF covers the ordinary case from inside the
// read loop; this covers the rest — a descriptor held open elsewhere, or a main
// thread too wedged to service the quit. Both routes end in a hard exit, so an
// orphaned surface can no longer sit above every window with nothing driving it.
Lifecycle.startOrphanWatchdog { command in
    controller.handle(command)
}

// Handshake: tell Electron main we're up and listening.
IPC.emit(.ready)

app.run()
