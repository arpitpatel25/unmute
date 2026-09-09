# Founder Video Recording Contract

Record each clip separately, looking into camera. Keep the delivery warm and direct. The product pauses at every action; never tell the viewer that a timed animation proves completion. Final footage replaces the built-in branded stand-in without changing clip IDs.

| Clip ID | Spoken copy / caption intent | Visible card | Armed when | Completion proof | Failure / repair | Max |
|---|---|---|---|---|---|---:|
| `welcome-privacy-v1` | “Welcome to Unmute. Your dictation is sent securely for transcription and we do not store it. Your Claude Code and Codex work stays between you and those tools.” | Privacy | first launch | Continue | replay | 18s |
| `permission-microphone-v1` | “First, let Unmute hear the moments when you choose to speak.” | Microphone | privacy accepted | macOS microphone grant | open System Settings and retry | 9s |
| `permission-accessibility-v1` | “Accessibility lets Unmute place the finished words at your cursor.” | Accessibility | microphone granted | signed app is AX-trusted | open System Settings and retry | 10s |
| `permission-input-monitoring-v1` | “Input Monitoring makes the global modifier shortcuts work in every app.” | Input Monitoring | Accessibility granted | native listener reports trusted | grant, relaunch, resume here | 10s |
| `permission-system-audio-v1` | “System audio is used only when you deliberately start Notetaker.” | System Audio | Input Monitoring granted | real audio tap starts | grant, relaunch, resume here | 10s |
| `provider-readiness-v1` | “Unmute works through the Claude Code or Codex CLI you already use. Choose one we found ready.” | provider choices | permission preflight complete | isolated CLI replies READY | exact install/sign-in repair | 14s |
| `dictation-explain-v1` | “Here is the simplest thing. Put your cursor in Notes, hold Function, speak this line, and release.” | phrase | Notes is frontmost | real paste receipt targets Notes | refocus Notes and retry | 13s |
| `instruct-explain-v1` | “Select that sentence and use Instruct to reshape it.” | instruction phrase | dictation delivered | real selected-text replacement in Notes | select text and retry | 11s |
| `capture-clipboard-v1` | “While you speak, copy a useful detail. Unmute combines it with your words.” | capture phrase | capture observer armed | observed item ID appears in delivered composition | copy again | 12s |
| `capture-screenshot-v1` | “Do the same with a normal screenshot. Your words and image arrive together.” | capture phrase | screenshot observer armed | observed screenshot ID appears in Notes delivery | Desktop-folder repair and retry | 12s |
| `orchestrator-explain-v1` | “Right Option talks to Orchestrator. Ask it to create this tiny file so you can see a real task run.” | exact task phrase | owned workspace selected | owned task completes and file contents verify | task/provider-specific retry | 16s |
| `agent-explain-v1` | “The Unmute Agent remembers your work and can create or resume tasks. Ask it for this follow-up, then open the task link.” | exact follow-up phrase | Agent lane uses owned workspace | structured task receipt and matching link open | retry without accepting prose links | 18s |
| `notetaker-explain-v1` | “Notetaker uses the excellent models you already pay for. Double-tap Left Control, say this line, then save from the real pill.” | note phrase | real Notetaker armed | meeting metadata and retained audio persist | discard/failure stays here | 18s |
| `orientation-v1` | “This is home: today’s tasks, automatic workspaces, and your Notetaker summaries—all in the Unmute app.” | Explore Unmute | real app visible | orientation action | replay clip | 14s |
| `sign-in-v1` | “Sign in now to keep using Unmute after this guided session.” | Sign in | all exercises complete | AuthContext confirms signed-in session | normal auth recovery | 8s |
| `complete-v1` | “That’s it. You now know Unmute because you have actually used it.” | Welcome | sign-in confirmed | terminal state | replay from Settings | 7s |

Caption text is sourced from `electron/onboarding/chapters.ts`. If spoken copy changes, update that file in the same change so silent/script mode remains complete.
