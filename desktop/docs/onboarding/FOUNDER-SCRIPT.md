# Founder Video Recording Contract

This is the complete review draft for the video-led onboarding. Record each clip separately, looking into camera. Keep the delivery warm, direct, and conversational. The product pauses at every required action; never imply that watching the video itself completes a step. Final footage replaces the built-in stand-in without changing clip IDs.

## 1. Meet Unmute

**Clip:** `welcome-product-v1`
**Founder says:** “Welcome to Unmute. Unmute lets you speak instead of type, turn requests into real work with Claude Code or Codex, and capture meeting notes without breaking your flow. In the next few minutes, you’ll use each part yourself.”
**On screen:** Meet Unmute — Dictate, delegate, and remember without leaving what you are doing.
**Completes when:** The user chooses Continue.

## 2. Privacy

**Clip:** `privacy-v1`
**Founder says:** “Before we begin, here’s how your data moves. Dictation is sent securely for transcription and is not stored by Unmute. Your Claude Code and Codex work goes directly through the tools you already use; Unmute does not proxy or store those conversations.”
**On screen:** Your privacy.
**Completes when:** The user chooses Continue.

## 3. Microphone

**Clip:** `permission-microphone-v1`
**Founder says:** “First, allow microphone access. Unmute only listens when you deliberately activate a recording feature.”
**On screen:** Allow Microphone.
**Completes when:** macOS reports that microphone access is granted. If denied, remain here and offer the correct System Settings route.

## 4. Accessibility

**Clip:** `permission-accessibility-v1`
**Founder says:** “Next, allow Accessibility. This lets Unmute recognize its shortcuts and place finished text wherever your cursor is.”
**On screen:** Allow Accessibility.
**Completes when:** The signed Unmute application is Accessibility-trusted. Save progress before any required relaunch and resume at this step.

## 5. System Audio

**Clip:** `permission-system-audio-v1`
**Founder says:** “Finally, allow System Audio. Unmute uses it only when you deliberately start Notetaker.”
**On screen:** Allow System Audio.
**Completes when:** The real system-audio preflight tap starts successfully. Save progress before any required relaunch.

## 6. Connect an agent

**Clip:** `provider-readiness-v1`
**Founder says:** “Unmute runs agent tasks through Claude Code or Codex on your Mac. We’ll check what is ready and help you set up either one if it is missing.”
**On screen:** Claude Code and Codex readiness cards. A missing provider offers Set up; an installed but signed-out provider offers Sign in.
**Completes when:** The selected provider passes an isolated readiness check and replies `READY`.

## 7. Dictation in Apple Notes

**Clip:** `dictation-explain-v1`
**Founder says:** “Let’s start with dictation. We’ve opened Apple Notes for you. Put your cursor in the note, hold the Function key, say the sentence shown here, and release.”
**User says:** “My first Unmute dictation.”
**Completes when:** The real delivery receipt confirms that the text was pasted into Apple Notes. Transcription alone, or delivery into another app, does not advance.

## 8. Add copied context

**Clip:** `capture-clipboard-v1`
**Founder says:** “You can also give Unmute context while you speak. Hold Function, begin saying the phrase shown here, copy the highlighted text, and then release. Unmute will combine both in the same result.”
**User says:** “Add this copied detail to my note.”
**Completes when:** The observed clipboard item is included in the delivered composition.

## 9. Add a screenshot

**Clip:** `capture-screenshot-v1`
**Founder says:** “The same thing works with screenshots. Hold Function, begin saying the phrase shown here, take a normal macOS screenshot, and then release.”
**User says:** “Include this screenshot in my note.”
**Completes when:** The observed screenshot is included in the delivered composition in Apple Notes.

## 10. Orchestrator

**Clip:** `orchestrator-explain-v1`
**Founder says:** “Orchestrator turns a spoken request into a real task for Claude Code or Codex. Press Right Option and say the request shown here. Unmute will send it to your chosen agent and keep the task available for you.”
**User says:** “Create hello-unmute.txt containing My first Unmute task.”
**Completes when:** The task finishes inside the onboarding workspace and `hello-unmute.txt` contains exactly `My first Unmute task`.

## 11. Unmute Agent

**Clip:** `agent-explain-v1`
**Founder says:** “The Unmute Agent helps you find, create, and continue work. It understands your Unmute tasks, sessions, and notes. Double-tap Right Command, say the follow-up shown here, and then open the task link it gives you.”
**User says:** “Create a follow-up task to add today’s date to hello-unmute.txt.”
**Completes when:** Unmute receives the structured task receipt and the user opens its matching native task link. Plain text that merely resembles a link does not count.

## 12. Notetaker

**Clip:** `notetaker-explain-v1`
**Founder says:** “Unmute also includes Notetaker. It uses the strong models you already pay for through Claude Code or Codex to create useful notes you can interact with later. Double-tap Left Control, say the line shown here, and save the recording from the pill.”
**User says:** “This is my first Unmute note.”
**Completes when:** The real Notetaker recording is saved and its meeting metadata and audio are retained. Stopping or discarding does not advance.

## 13. Your Unmute workspace

**Clip:** `orientation-v1`
**Founder says:** “This is your Unmute home. Orchestrator shows today’s tasks and automatically groups related work into workspaces. Notetaker keeps your recordings, transcripts, and summaries here. And when your notes are ready, you can ask the Unmute Agent to find information in them.”
**On screen:** The real Electron app, showing Orchestrator and Notetaker.
**Completes when:** The user chooses Continue.

## 14. Sign in

**Clip:** `sign-in-v1`
**Founder says:** “You’ve now used every major part of Unmute. Sign in to keep using it after this guided session.”
**On screen:** Sign in.
**Completes when:** Unmute confirms an authenticated session.

## 15. Complete

**Clip:** `complete-v1`
**Founder says:** “That’s it. You now know Unmute because you’ve actually used it. Welcome.”
**On screen:** Welcome to Unmute.
**Completes when:** The onboarding reaches its terminal state. It can be replayed later from Settings.

## Synchronization rule

The founder wording above is also the caption wording in `electron/onboarding/chapters.ts`. Any approved script edit must update the matching caption in the same commit so recorded footage, captions, and Script mode cannot drift apart.
