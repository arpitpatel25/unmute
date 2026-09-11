# Founder Video Recording Contract

Record each clip separately, looking into camera. Keep the delivery warm and direct. The product pauses at every action; never tell the viewer that a timed animation proves completion. Final footage replaces the built-in branded stand-in without changing clip IDs.

| Clip ID | Spoken copy / caption intent | Visible card | Armed when | Completion proof | Failure / repair | Max |
|---|---|---|---|---|---|---:|
| `welcome-privacy-v1` | “Welcome to Unmute. Your dictation is sent securely for transcription, and we do not store it. Your Claude Code and Codex work goes directly through the tools you already use, not through Unmute.” | Privacy | first launch | Continue | replay | 18s |
| `permission-microphone-v1` | “First, allow microphone access. Unmute only listens when you deliberately activate a recording feature.” | Microphone | privacy accepted | macOS microphone grant | open System Settings and retry | 9s |
| `permission-accessibility-v1` | “Next, allow Accessibility. This lets Unmute place the finished text wherever your cursor is.” | Accessibility | microphone granted | signed app is AX-trusted | open System Settings and retry | 10s |
| `permission-input-monitoring-v1` | “Allow Input Monitoring so Unmute’s keyboard shortcuts work from any application.” | Input Monitoring | Accessibility granted | native listener reports trusted | grant, relaunch, resume here | 10s |
| `permission-system-audio-v1` | “Finally, allow System Audio. Unmute uses it only when you deliberately start Notetaker.” | System Audio | Input Monitoring granted | real audio tap starts | grant, relaunch, resume here | 10s |
| `provider-readiness-v1` | “Unmute works with the Claude Code or Codex CLI already configured on your Mac. Choose the agent you would like to use.” | provider choices | permission preflight complete | isolated CLI replies READY | exact install/sign-in repair | 14s |
| `dictation-explain-v1` | “We opened Apple Notes for you. Put your cursor in the note, hold Function, say the sentence shown here, and release.” | phrase | Notes is frontmost | real paste receipt targets Notes | refocus Notes and retry | 13s |
| `instruct-explain-v1` | “Now select that sentence, press Caps Lock, and say the instruction shown here. Unmute will replace the selected text.” | instruction phrase | dictation delivered | real selected-text replacement in Notes | select text and retry | 11s |
| `capture-clipboard-v1` | “Unmute can combine your voice with captured context. Hold Function, begin speaking, copy the highlighted text, and then release.” | capture phrase | capture observer armed | observed item ID appears in delivered composition | copy again | 12s |
| `capture-screenshot-v1` | “It works with screenshots too. Hold Function, begin speaking, take a normal macOS screenshot, and then release.” | capture phrase | screenshot observer armed | observed screenshot ID appears in Notes delivery | Desktop-folder repair and retry | 12s |
| `orchestrator-explain-v1` | “Orchestrator turns a spoken request into a real task for Claude Code or Codex. Press Right Option and say the request shown here.” | exact task phrase | owned workspace selected | owned task completes and file contents verify | task/provider-specific retry | 16s |
| `agent-explain-v1` | “The Unmute Agent remembers your work and can create or resume tasks. Double-tap Right Command, say this follow-up, and open the task link it gives you.” | exact follow-up phrase | Agent lane uses owned workspace | structured task receipt and matching link open | retry without accepting prose links | 18s |
| `notetaker-explain-v1` | “Notetaker uses the models you already pay for. Double-tap Left Control, say the line shown here, and save the recording from the real pill.” | note phrase | real Notetaker armed | meeting metadata and retained audio persist | discard/failure stays here | 18s |
| `orientation-v1` | “This is your Unmute home: today’s tasks, automatic workspaces, and your Notetaker recordings and summaries.” | Explore Unmute | real app visible | orientation action | replay clip | 14s |
| `sign-in-v1` | “You have now used every major part of Unmute. Sign in to keep using it after this guided session.” | Sign in | all exercises complete | AuthContext confirms signed-in session | normal auth recovery | 8s |
| `complete-v1` | “That’s it. You now know Unmute because you have actually used it. Welcome.” | Welcome | sign-in confirmed | terminal state | replay from Settings | 7s |

The spoken copy above is also the exact caption text in `electron/onboarding/chapters.ts`. If the recording changes, update both in the same commit so video, captions, and Script mode remain synchronized.
