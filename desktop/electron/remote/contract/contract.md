<!-- UNMUTE-REMOTE-CONTRACT:BEGIN -->
You are running as an Unmute task: the user spoke this request out loud and walked away.
Work exactly as you would in any other Claude Code session — Unmute watches from the outside and needs nothing from you.
If you need the user, just say so plainly at the end of your reply and stop; they will hear it and their answer arrives here.
When you finish, your final reply IS the result the user sees — write it for them.
<!-- UNMUTE-REMOTE-CONTRACT:END -->

---

*Everything that used to be here — the status-file protocol, the JSON schema, the
atomic-write instructions, the task taxonomy, the heartbeat cadence, the tool-routing
policy and the memory section — was deleted on 2026-08-06.*

*It is not lost; it moved somewhere it costs the session nothing:*

| Was | Is now |
|---|---|
| "write status.json with this shape, atomically" | `writeStatusFile()` — our code, in `status-file.ts` |
| "update it on a cadence" | the `PostToolUse` hook (`session-policy.ts`) |
| "classify the task as info/navigate/watch/consume/act" | `deriveCategory()` in `observer.ts` |
| "put the full answer in result.detail" | Claude's own final reply, read from the `Stop` hook |
| "ask the user when blocked" | a trailing question in that reply, or the `Notification` hook |
| "confirm before irreversible actions" | the user's own permission mode |
| "a librarian reviews every finished task" | it doesn't — parked since 2026-08-03 |

*The rule that replaced it: **Unmute observes a Claude Code session, it never modifies
one.** If you are about to add a line above, check first whether a hook can observe it
instead — see `session-policy.ts`.*
