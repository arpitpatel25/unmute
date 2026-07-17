# Curator preflight findings (spec §11)

Date: 2026-07-17
Claude Code version tested: **2.1.212** (`claude --version` → `2.1.212 (Claude Code)`)
Method: automated by an agent (no human at the TUI). Print-mode checks via `claude -p`; interactive checks via a real TTY — `claude` running inside tmux 3.6b, input via `tmux send-keys`, rendered screen captured via `tmux capture-pane`. Test skill: `~/.claude/skills/unmute-preflight-test/SKILL.md` exactly as specified in the task brief (`disable-model-invocation: true` + unknown key `origin: unmute`), deleted after the run.

## Verdict summary

| # | Check | Verdict |
|---|-------|---------|
| 1 | Unknown `origin:` frontmatter key tolerated (parse + list + invoke) | **PASS** |
| 2 | `disable-model-invocation: true` — explicit `/name` works, model invocation blocked, description kept out of model context | **PASS** |
| 3 | `/name ` typed unsubmitted into a PTY, then Enter → real skill invocation | **PASS** |

**Consequence for Task 6: include the `origin: unmute` stamp.** The ledger-only fallback is not needed.

## Check 1 — unknown `origin:` key (PASS)

- `claude -p "/unmute-preflight-test"` from an unrelated directory printed exactly `PREFLIGHT-OK`, exit 0. No parse error or warning about the unknown key.
- In the interactive TUI, typing `/unmute-preflight-test` (unsubmitted) rendered the autocomplete menu entry, captured verbatim from the screen:

  ```
  /unmute-preflight-test    Preflight test skill for Unmute curator. When invoked, reply exactly PREFLIGHT-OK and stop. (user)
  ```

- In `--output-format stream-json`, the session `init` event's `slash_commands` array also contains `unmute-preflight-test`.

Unknown frontmatter keys are silently tolerated in 2.1.212: the skill still parses, lists, autocompletes, and invokes.

## Check 2 — `disable-model-invocation` semantics (PASS)

- **Explicit invocation still works:** the `claude -p "/unmute-preflight-test"` run above returned `PREFLIGHT-OK`, and the interactive `/name` submission in check 3 did too.
- **Model invocation is blocked at the harness, not just by prompt omission.** In a fresh `claude -p --output-format stream-json` session prompted with plain words ("run the unmute preflight test procedure"), the model did not know the skill — it went searching the filesystem for what the phrase meant (behavioral evidence the description was not injected into its context). When it eventually learned the name (from a capture file this test itself had left in the cwd) and attempted `Skill {"skill": "unmute-preflight-test"}`, the harness rejected it with:

  ```
  <tool_use_error>Skill unmute-preflight-test cannot be used with Skill tool due to disable-model-invocation</tool_use_error>
  ```

  So even a model that discovers the name cannot invoke the skill; the flag is enforced end-to-end.
- **`/context` sub-step, as literally written, is not observable in 2.1.212:** `/context` now shows only an aggregate line (`Skills · /skills — 126 skills · 8.3k tokens`) and does not enumerate per-skill descriptions in the default view, so "the listing does not include the description" cannot be read off that screen. The exclusion is instead established by the two behaviors above (model ignorance of the skill + explicit harness error naming `disable-model-invocation`). Treated as PASS on that evidence; only the exact visual phrasing of the brief's sub-step is moot on this version.

## Check 3 — `/name` typed into a PTY lands as an invocation (PASS)

Simulates D14 (tap writes `/name ` unsubmitted; user presses Enter). In the tmux-hosted interactive session:

1. Sent the literal text `/unmute-preflight-test` keystroke-by-keystroke → autocomplete menu popped up with the single matching entry (screen capture above).
2. Sent the trailing space → **the menu dismissed**; the input line held `❯ /unmute-preflight-test ` unsubmitted.
3. Sent Enter → direct submission (no menu-selection step intervened). The transcript rendered:

   ```
   ❯ /unmute-preflight-test
   ⏺ PREFLIGHT-OK
   ```

Exact behavior to record for Task 12: menu popup appears while the bare `/name` prefix is being typed, but the trailing space closes it, so Enter submits the typed text directly as a skill invocation — not as a literal chat message and not via menu selection. Writing `/name ` **with the trailing space** is therefore the safe form for tap-to-invoke.

## Notes / caveats

- One PTY attempt via raw `pty.fork` produced unreadably partial frames (Ink redraws + kitty keyboard protocol); the tmux run is the authoritative interactive evidence since `capture-pane` returns the true rendered screen.
- All interactive evidence was captured programmatically, not by human eyes; screen captures quoted above are verbatim from `tmux capture-pane`.
- Cleanup done: `~/.claude/skills/unmute-preflight-test` removed after the run.
