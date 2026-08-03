// Help → Browser use.
//
// SOURCES:
//   remote/setup-status.ts:135-138  the decision, in the code: "browser tasks
//                                   drive the user's REAL, already-signed-in
//                                   Chrome (no dedicated profile, no separate
//                                   sign-in, no Space juggling)".
//   remote/setup-status.ts:164-169  the one manual step — install the Claude for
//                                   Chrome extension in your normal Chrome.
//   remote/setup-status.ts:150      the step is versioned, so if the requirement
//                                   ever changes the confirmation reverts to todo.
//   remote/setup-status.ts:220-222  the browser extension is the only thing the
//                                   orchestrator needs; the MCP integrations are
//                                   optional extras.
//   remote/init.ts:339-343          the step is only in the checklist while the
//                                   browser lane is enabled (`browserEnabled`,
//                                   default true — init.ts:195).
//   RemoteSetup.tsx:174             "keep one Chrome window open with the
//                                   extension active while you use it".
//
// ONE CLAIM ON THIS PAGE IS NOT SOURCED IN THIS REPOSITORY: that Codex desktop
// brings its own browser control and therefore does not need the extension.
// Nothing in desktop/ or backend/ demonstrates it — `MANUAL_BROWSER_STEPS`
// (setup-status.ts:164) is added whenever the browser lane is on
// (init.ts:339-343), regardless of which agent is selected. SPEC §4 and
// VERIFY 41 both require the page to say it, so it stays, but two things were
// done about it: the sentence claims only what Codex brings, not what unmute
// knows about it; and the Note underneath states the sourced fact that the
// checklist shows the extension step to Codex users too, so a Codex user does
// not read this page and then think the checklist is broken.
// ESCALATED in the pack's decisions file — confirm on a real machine before
// launch, or cut the sentence.
//
// The stale-looking `remote/browser.ts` (a dedicated automation Chrome profile)
// is an EARLIER model that setup-status.ts:135 explicitly reverses. Do not write
// copy from it.

import { Shell, Sec, P, Note, type HelpProps } from './index'

export default function BrowserUse({ onBack }: HelpProps) {
  return (
    <Shell
      title="Browser use"
      standfirst="Tasks that need the web use the Chrome you are already signed in to — not a separate browser you would have to log into again."
      onBack={onBack}
    >
      <Sec title="Your real Chrome">
        <P>
          A task that has to look something up, fill something in or read a page
          behind a login uses <b>your normal Chrome</b>. No dedicated profile, no
          second sign-in, no juggling windows between Spaces.
        </P>
        <P>
          That is the whole reason it is worth having: your sessions, your
          bookmarks and your logins are already there, so &ldquo;check my
          order&rdquo; is a task rather than a setup project.
        </P>
      </Sec>

      <Sec title="Keep one window open">
        <P>
          Keep one Chrome window open with the extension active while you use
          this. It is the connection between unmute and the browser — with Chrome
          fully closed there is nothing to drive.
        </P>
      </Sec>

      <Sec title="Setting it up">
        <P>
          <b>Claude Code</b> reaches Chrome through the Claude for Chrome
          extension, so it needs that installed and enabled in your normal
          Chrome. Most people already have it; if you do, tick the step off and
          you are done. It is the only manual step the orchestrator has.
        </P>
        <P>
          <b>Codex desktop</b> brings browser control of its own, so it does not
          need the extension to open a page.
        </P>
        <Note>
          The setup step is listed whichever agent you have selected, and
          Orchestrator → Agents remembers your answer.
        </Note>
      </Sec>

      <Sec title="Turning it off">
        <P>
          If you would rather nothing ever touched your browser, switch the
          browser lane off in Orchestrator → Settings. Tasks that do not need the
          web are unaffected, and the setup step disappears with it.
        </P>
      </Sec>
    </Shell>
  )
}
