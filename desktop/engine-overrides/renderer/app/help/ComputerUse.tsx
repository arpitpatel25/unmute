// Help → Computer use.
//
// SOURCES:
//   remote/ax/register.ts:1-13   the whole point of the lane: an MCP server that
//                                Claude Code's tool routing PREFERS over screen
//                                control, plus a one-line steer in CLAUDE.md, so
//                                the model "doesn't reach for focus-stealing
//                                screen control". The built-in is deliberately
//                                left in place as a fallback.
//   remote/ax/register.ts:36-40  the server is named `unmute-computer`.
//   remote/ax/register.ts:73     it is registered with `claude mcp add-json …
//                                --scope user` — i.e. into Claude Code, and
//                                into every project.
//   remote/ax/policy.ts:8-13     two switches: `enabled` is the real kill switch;
//                                `screenshotEnabled` is separate "because capture
//                                needs a separate (Screen Recording) grant".
//   remote/ax/policy.ts:15-19    allowAll = true is the default; the allowlist is
//                                an optional restriction, never a gate.
//   remote/ax/policy.ts:29-30    DEFAULT_POLICY.enabled = false — "opt-in:
//                                nothing happens until the user turns Computer
//                                Use on".
//   remote/cua/driver-manager.ts:11-13  macOS caches TCC answers per process, so
//                                a grant made while a driver is running is
//                                invisible until it restarts — hence the poll and
//                                the restart on Accessibility flipping true.
//   remote/cua/driver-manager.ts:92-100 accessibility and screenRecording are
//                                checked separately.
//
// NOT CLAIMED: what any other vendor's agent can or cannot do. What IS true and
// checkable is where unmute registers these tools — Claude Code — and that is
// what the last card says.

import { Shell, Sec, P, Lit, Note, type HelpProps } from './index'

export default function ComputerUse({ onBack }: HelpProps) {
  return (
    <Shell
      title="Computer use"
      standfirst="Lets an agent operate apps on this Mac in the background, without taking your screen away from you."
      onBack={onBack}
    >
      <Sec title="The screen never moves">
        <P>
          The usual way an agent drives a computer is to take the screen: bring
          an app to the front, move the real cursor, click at coordinates. You
          cannot use your Mac while that happens, and one stray click lands
          somewhere unintended.
        </P>
        <P>
          This lane does it through the accessibility layer instead. It reads the
          window&rsquo;s structure and acts on named elements, so apps can be
          driven while they are behind other windows. Your foreground app stays
          foreground, your cursor stays where you left it, and you can keep
          working while a task runs.
        </P>
      </Sec>

      <Sec title="It needs Accessibility">
        <P>
          Reading and operating another app&rsquo;s controls is exactly what the
          Accessibility permission governs, so this does not work without it.
          Settings → Permissions.
        </P>
        <P>
          macOS caches permission answers per process, so a grant made while
          something is already running is invisible to it. Unmute watches for
          Accessibility being turned on and restarts the drivers itself — you do
          not have to quit the app.
        </P>
        <Note>
          Screenshots are a separate grant. Screen Recording is only needed if
          you want the agent to be able to capture a window.
        </Note>
      </Sec>

      <Sec title="It is off until you turn it on">
        <P>
          Computer use is opt-in, and nothing runs until you enable it — this is
          real control of your machine, so it does not arrive switched on.
        </P>
        <P>
          Once it is on, the default scope is the whole computer, because a tool
          that can only touch a hand-picked few apps is not much of a tool. You
          can narrow it to a specific list of apps instead, and switching it back
          off is a genuine kill switch: every call is refused.
        </P>
        <Note>Orchestrator → Settings, under Computer use.</Note>
      </Sec>

      <Sec title="Which agent gets it">
        <P>
          Unmute registers these tools with <b>Claude Code</b>, as an MCP server
          called <Lit>unmute-computer</Lit>, for every project. Claude Code
          prefers an MCP server over its own screen control, so once this is on
          it reaches for the background tools first.
        </P>
        <P>
          The built-in screen control is deliberately left in place underneath as
          a fallback for the rare thing the accessibility layer genuinely cannot
          do.
        </P>
      </Sec>
    </Shell>
  )
}
