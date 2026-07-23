import AppKit

// Entry point. Runs as an .accessory app (no Dock icon, never becomes active,
// so it can never steal focus from the user's foreground app). Stdin is read on
// a background thread; decoded commands are dispatched to AppController on the
// main queue. Stdout carries events back to Electron main.

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let controller = AppController()

IPC.startReadLoop { command in
    controller.handle(command)
}

// Handshake: tell Electron main we're up and listening.
IPC.emit(.ready)

app.run()
