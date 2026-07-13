# ax-mcp

Background macOS app control for Claude Code, via the Accessibility API.

Claude Code's built-in computer use moves your real mouse at real screen coordinates.
That forces it to bring the target app to the front — and if you switch away, it
re-screenshots, doesn't find the app, and yanks it forward again. It interrupts you.

`ax-mcp` acts on **UI elements**, not coordinates. `AXPress` on a button works
whether or not the app is focused, visible, or frontmost. Nothing moves. You keep working.

## Build

```bash
swiftc -O main.swift -o ax-mcp -framework Cocoa -framework ApplicationServices
```

No dependencies. No network calls. Apple frameworks only.

## Install

```jsonc
// ~/.claude.json
{
  "mcpServers": {
    "ax-mcp": {
      "command": "/absolute/path/to/ax-mcp",
      "env": {
        "AX_MCP_ALLOWED": "Notion,WhatsApp,Notes"   // "*" for all; empty = nothing
      }
    }
  }
}
```

Then **disable the built-in computer-use server** so Claude Code routes here instead:
run `/mcp` in a session, select `computer-use`, choose Disable.

Claude Code prefers MCP tools over screen control, so once ax-mcp is present it will
reach for these tools first.

## Permissions

- **Accessibility** — required. Grant it to the process that *launches* ax-mcp
  (your terminal, or Claude Code). System Settings → Privacy & Security → Accessibility.
- **Screen Recording** — only needed for `capture_window`. Skip it if you don't want
  capture; every other tool works without it.

## Tools

| tool | what it does | focus? |
|---|---|---|
| `list_apps` | running apps + window counts | — |
| `find` | search elements by label/role → ids | no |
| `get_tree` | full tree (noisy; prefer `find`) | no |
| `press` | AXPress an element | **no** |
| `set_value` | write a text field | **no** |
| `fill_form` | write many fields in one call | **no** |
| `menu_action` | drive the menu bar, e.g. `File > Save` | **no** |
| `capture_window` | screenshot ONE window, not the screen | **no** |

## Two things that matter

**Electron.** Chromium ships its accessibility tree *disabled*. `ax-mcp` sets
`AXManualAccessibility` on every app it touches, which is what makes Notion, Slack,
WhatsApp, and Discord readable at all. Tools built on AppleScript/System Events cannot
set this flag, which is why they silently return nothing on those apps.

Electron apps also report `AXWindows = []` even with a window open, so `ax-mcp` falls
back to `AXMainWindow` / `AXFocusedWindow`.

**Spaces.** The Accessibility API cannot see windows on *other* macOS Spaces. "Background"
here means *same Space, not focused* — not *another desktop*. An app parked on another
Space reports zero windows and is unreachable. This is an OS limit, not a bug.

## Notes

- Element ids come from a tree walk and **change after any action**. Re-run `find`
  between steps.
- There is deliberately no `activate_app` tool. Bringing apps forward is the thing
  this exists to avoid.
- `set_value` fails on some apps that require a focused field. Fall back to
  `menu_action` or `press` where that happens.
