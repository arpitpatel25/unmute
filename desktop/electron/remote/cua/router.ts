// Lane router — the tool surface Claude Code actually calls for computer use
// of Electron/Chromium apps and scriptable native apps. Ties together three
// already-built lanes (see ./lanes/*) into MCP tool defs + a dispatcher:
//   - web_arm / web_eval / web_type / web_screenshot  → CdpLane (via Arming
//     for web_arm), for Electron/Chromium apps (Notion, Slack, WhatsApp, …).
//     CDP is immune to Space/focus/compositor state — see lanes/cdp.ts.
//   - run_applescript                                  → the Apple Events
//     lane, for scriptable native apps (Notes, Mail, Finder, …).
// Everything else (native AX driving, non-scriptable apps) stays on the cua
// tools (list_apps/find/press/…) registered separately — this router only
// owns the five tools above.
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

const ROUTER_TOOL_NAMES = ['web_arm', 'web_eval', 'web_type', 'web_screenshot', 'run_applescript'] as const

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
