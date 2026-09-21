# Founder Video Recording Contract

This document reflects the footage recorded on 21 September 2026. Each visible chapter has one founder clip. The application waits for the real product event described under **Completes when**; video playback alone never advances an interactive exercise.

## 1. Meet Unmute

**Clip:** `welcome-product-v1`

**Founder says:** “Hey, welcome to Unmute. We believe that ideas don’t appear in a chat box. They happen when you’re scrolling through the web or Twitter, watching a YouTube video, or going through a Slack conversation. Unmute lets you turn those thoughts into actions then and there. With the press of a key, you can create new tasks, continue existing tasks, or dictate anywhere across your Mac. Let’s try it out.”

**Completes when:** The user chooses Continue.

## 2. Privacy

**Clip:** `privacy-v1`

**Founder says:** “Before we begin, a quick note on privacy. Only your dictation goes through Unmute so we can transcribe it, and we don’t store it. Your Claude and Codex activity never passes through Unmute.”

**Completes when:** The user chooses Continue.

## 3. Microphone

**Clip:** `permission-microphone-v1`

**Founder says:** “First, you need to allow microphone access. Unmute only listens to your audio when you deliberately start dictation.”

**Completes when:** macOS reports that microphone access is granted.

## 4. Accessibility

**Clip:** `permission-accessibility-v1`

**Founder says:** “Next, you need to allow Accessibility. This lets Unmute recognize shortcuts and place the text wherever your cursor is.”

**Completes when:** The signed Unmute application is Accessibility-trusted. Progress survives any required relaunch.

## 5. Function key readiness

**Clip:** `function-key-readiness-v1`

**Founder says:** “Before you dictate, we need to make sure macOS leaves the Function key available for Unmute. Open Keyboard Settings and set ‘Press Globe key to’ to ‘Do Nothing.’ Once done, come back and press the Function key so Unmute can verify it.”

**Completes when:** Unmute’s shipping keyboard listener observes the real Function-key press.

## 6. System Audio

**Clip:** `permission-system-audio-v1`

**Founder says:** “Finally, you need to allow System Audio access to Unmute. Unmute only uses this when you deliberately turn on the Notetaker feature.”

**Completes when:** The real system-audio preflight succeeds.

## 7. Connect Claude Code or Codex

**Clip:** `provider-readiness-v1`

**Founder says:** “Unmute runs AI-agent tasks through Claude and Codex on your Mac. We’ll check what is configured, what is missing, and help you finish the setup.”

**Completes when:** The selected provider passes an isolated readiness check.

## 8. Dictation in Apple Notes

**Clip:** `dictation-explain-v1`

**Founder says:** “Now let’s start with dictation. We’ve opened Apple Notes for you. Place your cursor in the note, tap the Function key and say something—maybe the sentence shown below—and then tap the Function key again to submit.”

**User says:** “My first Unmute dictation.”

**Completes when:** A real delivery receipt confirms that text was pasted into Apple Notes.

## 9. Add copied context

**Clip:** `capture-clipboard-v1`

**Founder says:** “You can also copy text, links, or anything else while you’re dictating, and it becomes part of the dictation. Tap the Function key, dictate a phrase, copy some text with Command-C, return to Notes, place your cursor, and tap Function again. Your dictation and the selected text are pasted together.”

**User says:** “Add this copied detail to my note.”

**Completes when:** The observed clipboard item is included in the delivered composition.

## 10. Add screenshots

**Clip:** `capture-screenshot-v1`

**Founder says:** “The same thing works for screenshots. Press Function to start dictation and speak. While you’re dictating, you can copy text and take normal Mac screenshots. You can take multiple screenshots. When you’re done, return to where you want the result and press Function again. What you dictated is pasted together with the text and screenshots you captured.”

**User says:** “Include this screenshot in my note.”

**Completes when:** The observed screenshot is included in the delivered composition in Apple Notes.

## 11. Turn a thought into a task

**Clip:** `orchestrator-explain-v1`

**Founder says:** “Now let’s turn a thought into a task. Unmute sends your spoken request to a Claude or Codex session. It will either create a new session or route it to an existing one. Tap Right Option, say the request shown below, then tap Right Option again.”

**User says:** “Create hello-unmute.txt containing My first Unmute task.”

**Completes when:** The task finishes in the onboarding workspace and the output file contains the expected text.

## 12. Unmute Agent

**Clip:** `agent-explain-v1`

**Founder says:** “Unmute Agent is a specialized Claude or Codex session that helps you find, create, or continue work. Think of it as a task manager for your sessions. You can ask to continue work from days ago and it resumes the right session with the right context. Double-tap Right Command, say the message shown below, then press Right Command again to submit.”

**User says:** “Create a follow-up task to add today’s date to hello-unmute.txt.”

**Completes when:** The Agent provides a structured task link and the user opens it.

## 13. Notetaker

**Clip:** `notetaker-explain-v1`

**Founder says:** “Unmute also includes a Notetaker. It uses the strong models you already pay for through your Claude or Codex subscriptions. Double-tap Left Control to start Notetaker, say the line shown below, then finish and save the recording from the pill. Your demo note will be ready shortly.”

**User says:** “This is my first Unmute note.”

**Completes when:** The real Notetaker recording is saved. Stopping or discarding does not advance.

## 14. Ask about your notes

**Clip:** `agent-notes-v1`

**Founder says:** “One useful part of Unmute Agent is that it has access to notes you captured with Notetaker. Invoke Unmute Agent and ask it to summarize a note or find a detail from a particular day. It can find the right information from your notes.”

**Completes when:** The user chooses Continue.

## 15. Your Unmute dashboard

**Clip:** `orientation-v1`

**Founder says:** “It lists all the tasks triggered by Unmute and groups them into workspaces automatically, so you don’t have to manage that part.”

**Completes when:** The user chooses Explore Unmute. The real dashboard and Notetaker views are opened.

## 16. Sign in and finish

**Clip:** `sign-in-v1`

**Founder says:** “The demo ends here, and you have now used every major part of Unmute. You’ll be directed to the sign-in page so you can proceed with sign-in.”

**Completes when:** Unmute confirms an authenticated session, closes the presenter, and records terminal completion. The onboarding can be replayed later from Settings.

## Synchronization rule

The bundled video is the primary presentation. The matching `caption` in `electron/onboarding/chapters.ts` is the concise fallback shown only if the video cannot load. Any future recording change must update both in the same commit.
