// Lane router — the tool surface Claude Code actually calls for computer use
// of Electron/Chromium apps and scriptable native apps. Ties together three
// already-built lanes (see ./lanes/*) into MCP tool defs + a dispatcher:
//   - web_arm / web_eval / web_type / web_screenshot / web_click / web_key /
//     web_drag / web_navigate / web_scroll / web_wait / web_targets /
//     web_click_text                                   → CdpLane (via Arming
//     for web_arm), for Electron/Chromium apps (Notion, Slack, WhatsApp, …).
//     CDP is immune to Space/focus/compositor state — see lanes/cdp.ts.
//   - run_applescript                                  → the Apple Events
//     lane, for scriptable native apps (Notes, Mail, Finder, …).
// Everything else (native AX driving, non-scriptable apps) stays on the cua
// tools (list_apps/find/press/…) registered separately — this router only
// owns the tools above.
//
// POLICY: the master kill switch (policy.enabled) is enforced upstream in
// server.ts. This router owns the ALLOWLIST — any call with an `app` arg is
// checked against policy.allowAll/allowed before it reaches a lane.
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import type { CdpLane } from './lanes/cdp'
import type { Arming } from './lanes/arming'
import { runAppleScript } from './lanes/applescript'
import { isAppAllowed, type AxPolicy } from '../ax/policy'

export interface RouterCtx {
  cdp: CdpLane
  arming: Arming
  runAppleScript: typeof runAppleScript
  /** Read live so UI toggles apply with no restart. */
  getPolicy(): AxPolicy
}

export interface McpTool {
  name: string
  description: string
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
}

export type RouterToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

function toolText(text: string, isError = false): RouterToolResult {
  return { content: [{ type: 'text', text }], isError }
}

const ROUTER_TOOL_NAMES = [
  'web_arm', 'web_eval', 'web_type', 'web_screenshot',
  'web_click', 'web_key', 'web_drag', 'web_navigate', 'web_scroll', 'web_wait', 'web_targets', 'web_click_text',
  'run_applescript',
] as const

// Matches `tell application "<X>"` (case-insensitive) so run_applescript can
// be allowlist-checked even though it has no `app` arg of its own.
const TELL_APPLICATION_RE = /\btell\s+application\s+"([^"]+)"/gi
function extractAppleScriptTargets(script: string): string[] {
  return [...script.matchAll(TELL_APPLICATION_RE)].map((m) => m[1])
}

// `do shell script` runs arbitrary shell commands via osascript — that's a
// full escape hatch out of the AppleScript-target allowlist, so it's
// rejected outright whenever the allowlist is enforced.
const DO_SHELL_SCRIPT_RE = /\bdo\s+shell\s+script\b/i

const TOOLS: McpTool[] = [
  {
    name: 'web_arm',
    description:
      'Arm an Electron/Chromium app (Notion, Slack, WhatsApp, and similar) for the web_* tools by relaunching it with a CDP debug port. ' +
      'Call this FIRST, once per app, before web_eval/web_type/web_screenshot. This is the ONE focus-affecting step in the whole ' +
      'computer-use surface (it quits + relaunches the app) — everything after it runs against the backgrounded window with no ' +
      'focus/cursor/screen interaction. Use web_* (after arming) for Electron/Chromium apps; use run_applescript for scriptable ' +
      'native apps; use the other cua tools (list_apps/find/press/…) for everything else.',
    inputSchema: {
      type: 'object',
      properties: { app: { type: 'string', description: 'App name, e.g. "Notion".' } },
      required: ['app'],
    },
  },
  {
    name: 'web_eval',
    description:
      'Run JavaScript in an armed Electron/Chromium app\'s page via CDP and return the JSON result. Use this to read page state ' +
      '(DOM queries, document.title, etc) or drive Electron/Chromium apps (Notion, Slack, WhatsApp) in the background — no focus ' +
      'steal, immune to Space/compositor state. Requires web_arm first. For scriptable native apps use run_applescript instead.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App name — must already be armed via web_arm.' },
        js: { type: 'string', description: 'JavaScript expression to evaluate in the page.' },
      },
      required: ['app', 'js'],
    },
  },
  {
    name: 'web_type',
    description:
      'Type text into an armed Electron/Chromium app\'s focused editor via CDP real per-character key events (needed for rich-text ' +
      'editors like Notion that discard one-shot insertText). Background, no focus steal. Requires web_arm first.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App name — must already be armed via web_arm.' },
        text: { type: 'string', description: 'Text to type.' },
      },
      required: ['app', 'text'],
    },
  },
  {
    name: 'web_screenshot',
    description:
      'Screenshot an armed Electron/Chromium app\'s page via CDP (Page.captureScreenshot) — works even off-Space or backgrounded, ' +
      'where OS-level screen capture is stale/blocked. Writes a PNG to a temp file and returns its path. Requires web_arm first.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App name — must already be armed via web_arm.' },
        out_file: { type: 'string', description: 'Optional path to write the PNG to. Defaults to a temp file.' },
      },
      required: ['app'],
    },
  },
  {
    name: 'web_click',
    description:
      'Trusted mouse click at page pixel (x,y) via CDP — use when web_eval\'s el.click() doesn\'t fire the app\'s handlers, or for ' +
      'canvas/no-DOM targets. Requires web_arm.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App name — must already be armed via web_arm.' },
        x: { type: 'number', description: 'Page pixel x coordinate.' },
        y: { type: 'number', description: 'Page pixel y coordinate.' },
      },
      required: ['app', 'x', 'y'],
    },
  },
  {
    name: 'web_key',
    description:
      'Press a key/shortcut (Enter, Escape, Tab, ArrowDown, or a char with modifiers like [\'cmd\']). web_type only enters text — ' +
      'use this to submit/close/hotkey. Requires web_arm.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App name — must already be armed via web_arm.' },
        key: { type: 'string', description: 'Key name (e.g. "Enter", "Escape", "Tab", "ArrowDown") or single character.' },
        modifiers: { type: 'array', items: { type: 'string' }, description: 'Optional modifier keys, e.g. ["cmd"], ["shift"].' },
      },
      required: ['app', 'key'],
    },
  },
  {
    name: 'web_drag',
    description: 'Trusted drag (canvas/sliders/reorder). Requires web_arm.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App name — must already be armed via web_arm.' },
        x1: { type: 'number', description: 'Start page pixel x.' },
        y1: { type: 'number', description: 'Start page pixel y.' },
        x2: { type: 'number', description: 'End page pixel x.' },
        y2: { type: 'number', description: 'End page pixel y.' },
      },
      required: ['app', 'x1', 'y1', 'x2', 'y2'],
    },
  },
  {
    name: 'web_navigate',
    description: 'Navigate the armed app\'s page to a URL. Requires web_arm.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App name — must already be armed via web_arm.' },
        url: { type: 'string', description: 'URL to navigate to.' },
      },
      required: ['app', 'url'],
    },
  },
  {
    name: 'web_scroll',
    description: 'Wheel-scroll the page by deltaY/deltaX at optional x,y. Requires web_arm.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App name — must already be armed via web_arm.' },
        deltaY: { type: 'number', description: 'Vertical scroll delta.' },
        deltaX: { type: 'number', description: 'Optional horizontal scroll delta. Defaults to 0.' },
        x: { type: 'number', description: 'Optional page pixel x to scroll at. Defaults to 0.' },
        y: { type: 'number', description: 'Optional page pixel y to scroll at. Defaults to 0.' },
      },
      required: ['app', 'deltaY'],
    },
  },
  {
    name: 'web_wait',
    description: 'Wait until a JS expression returns truthy (up to timeoutMs) — use between steps instead of guessing. Requires web_arm.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App name — must already be armed via web_arm.' },
        js: { type: 'string', description: 'JS expression polled until truthy.' },
        timeoutMs: { type: 'number', description: 'Max time to wait in milliseconds. Defaults to 5000.' },
      },
      required: ['app', 'js'],
    },
  },
  {
    name: 'web_targets',
    description: 'List the app\'s open pages/tabs (id,title,url) to see which you\'re driving. Requires web_arm.',
    inputSchema: {
      type: 'object',
      properties: { app: { type: 'string', description: 'App name — must already be armed via web_arm.' } },
      required: ['app'],
    },
  },
  {
    name: 'web_click_text',
    description: 'Click the element whose visible text matches. Requires web_arm.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App name — must already be armed via web_arm.' },
        text: { type: 'string', description: 'Visible text to match and click.' },
      },
      required: ['app', 'text'],
    },
  },
  {
    name: 'run_applescript',
    description:
      'Run an AppleScript via `osascript` — the most reliable way to drive scriptable native macOS apps that expose a proper ' +
      'AppleScript dictionary (Notes, Mail, Finder, System Events UI-scripting fallbacks, …). No screen/cursor/focus interaction. ' +
      'For Electron/Chromium apps use web_* instead; for everything else use the other cua tools.',
    inputSchema: {
      type: 'object',
      properties: { script: { type: 'string', description: 'AppleScript source to run.' } },
      required: ['script'],
    },
  },
]

export function routerTools(): McpTool[] {
  return TOOLS
}

export function isRouterTool(name: string): boolean {
  return (ROUTER_TOOL_NAMES as readonly string[]).includes(name)
}

export async function handleRouterTool(name: string, args: any, ctx: RouterCtx): Promise<RouterToolResult> {
  const app = typeof args?.app === 'string' ? args.app : undefined
  const policy = ctx.getPolicy()
  if (app !== undefined) {
    if (!policy.allowAll && !isAppAllowed(policy, app)) {
      return toolText(`'${app}' is not allowed by the Computer Use allowlist. The user can add it in Unmute settings, or switch to allow-all.`, true)
    }
  }

  // run_applescript has no `app` arg, so the check above never runs for it —
  // without this it ran fully unrestricted regardless of the allowlist.
  // Only enforced when the allowlist is actually on; allowAll (the
  // default) keeps run_applescript unrestricted.
  if (name === 'run_applescript' && !policy.allowAll) {
    const script = typeof args?.script === 'string' ? args.script : ''
    const targets = extractAppleScriptTargets(script)
    const disallowed = targets.find((t) => !isAppAllowed(policy, t))
    if (disallowed !== undefined) {
      return toolText(`'${disallowed}' is not allowed by the Computer Use allowlist. The user can add it in Unmute settings, or switch to allow-all.`, true)
    }
    if (DO_SHELL_SCRIPT_RE.test(script)) {
      return toolText('run_applescript containing "do shell script" is not allowed by the Computer Use allowlist (arbitrary shell escape). Switch to allow-all to run it.', true)
    }
  }

  try {
    switch (name) {
      case 'web_arm': {
        const result = await ctx.arming.arm(app!)
        let title: string | undefined
        try {
          const t = await ctx.cdp.eval(app!, 'document.title')
          if (typeof t === 'string') title = t
        } catch { /* best-effort — report the port regardless */ }
        const titlePart = title !== undefined ? `, page title: "${title}"` : ''
        return toolText(`armed ${result.app} on port ${result.port} (alreadyArmed: ${result.alreadyArmed})${titlePart}`)
      }
      case 'web_eval': {
        if (typeof args?.js !== 'string') return toolText('missing required argument: js', true)
        const result = await ctx.cdp.eval(app!, args.js)
        return toolText(JSON.stringify(result))
      }
      case 'web_type': {
        if (typeof args?.text !== 'string') return toolText('missing required argument: text', true)
        await ctx.cdp.typeKeys(app!, args.text)
        return toolText(`typed into ${app} (background, no focus change)`)
      }
      case 'web_screenshot': {
        const png = await ctx.cdp.screenshot(app!)
        const outFile = typeof args?.out_file === 'string' && args.out_file
          ? args.out_file
          : join(tmpdir(), `unmute-web-screenshot-${randomUUID()}.png`)
        await writeFile(outFile, png)
        return toolText(`screenshot of ${app} written to ${outFile}`)
      }
      case 'web_click': {
        if (typeof args?.x !== 'number' || typeof args?.y !== 'number') return toolText('missing required argument: x, y', true)
        const result = await ctx.cdp.click(app!, args.x, args.y)
        return toolText(JSON.stringify(result))
      }
      case 'web_key': {
        if (typeof args?.key !== 'string') return toolText('missing required argument: key', true)
        const result = await ctx.cdp.key(app!, args.key, Array.isArray(args?.modifiers) ? args.modifiers : [])
        return toolText(JSON.stringify(result))
      }
      case 'web_drag': {
        if (typeof args?.x1 !== 'number' || typeof args?.y1 !== 'number' || typeof args?.x2 !== 'number' || typeof args?.y2 !== 'number') {
          return toolText('missing required argument: x1, y1, x2, y2', true)
        }
        const result = await ctx.cdp.drag(app!, args.x1, args.y1, args.x2, args.y2)
        return toolText(JSON.stringify(result))
      }
      case 'web_navigate': {
        if (typeof args?.url !== 'string') return toolText('missing required argument: url', true)
        const result = await ctx.cdp.navigate(app!, args.url)
        return toolText(JSON.stringify(result))
      }
      case 'web_scroll': {
        if (typeof args?.deltaY !== 'number') return toolText('missing required argument: deltaY', true)
        const result = await ctx.cdp.scroll(app!, args.deltaY, typeof args?.deltaX === 'number' ? args.deltaX : 0,
          typeof args?.x === 'number' ? args.x : 0, typeof args?.y === 'number' ? args.y : 0)
        return toolText(JSON.stringify(result))
      }
      case 'web_wait': {
        if (typeof args?.js !== 'string') return toolText('missing required argument: js', true)
        const result = await ctx.cdp.waitFor(app!, args.js, typeof args?.timeoutMs === 'number' ? args.timeoutMs : 5000)
        return toolText(JSON.stringify(result))
      }
      case 'web_targets': {
        const result = await ctx.cdp.targets(app!)
        return toolText(JSON.stringify(result))
      }
      case 'web_click_text': {
        if (typeof args?.text !== 'string') return toolText('missing required argument: text', true)
        const result = await ctx.cdp.clickText(app!, args.text)
        return toolText(JSON.stringify(result))
      }
      case 'run_applescript': {
        const result = await ctx.runAppleScript(args?.script)
        return toolText(result)
      }
      default:
        return toolText(`unknown tool: ${name}`, true)
    }
  } catch (e) {
    return toolText(`${name} failed: ${(e as Error).message}`, true)
  }
}
