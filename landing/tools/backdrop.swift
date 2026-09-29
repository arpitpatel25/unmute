// Borderless full-screen wallpaper window for capture runs. Sits ABOVE the menu
// bar (so nothing of the real desktop leaks into the glass) and BELOW the notch
// helper's windows (level 1000). Usage: backdrop <image.png>; quits on SIGTERM.
import AppKit
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let screen = NSScreen.screens[0]
let win = NSWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
win.level = NSWindow.Level(rawValue: 500)
win.collectionBehavior = [.canJoinAllSpaces, .stationary]
let view = NSImageView(frame: NSRect(origin: .zero, size: screen.frame.size))
view.image = NSImage(contentsOfFile: CommandLine.arguments[1])
view.imageScaling = .scaleAxesIndependently
win.contentView = view
win.setFrame(screen.frame, display: true)
win.orderFrontRegardless()
app.run()
