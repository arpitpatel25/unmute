# Warm Agent sessions

The app host selects `runtime: 'persistent'` for both providers. The rollback
mode is `headless`. Claude uses stream-json stdin/stdout with the same system
prompt, allowlist, denylist, strict MCP configuration and medium effort.
`--replay-user-messages` acknowledges each warm user turn. Codex uses an owned
stdio app-server process with one thread and structured turn IDs, the same
developer instructions, medium effort, never approval policy and read-only
sandbox. Unexpected server approval requests are rejected.

The process environment holds an in-memory session credential alias. It is
not an interaction grant: resolution follows only that run/provider's current
unexpired grant. Completion revokes the grant; between turns the alias grants
nothing. The host destroys aliases on close/reap/shutdown. Runtime reuse also
requires identical run, system context path, model, cwd, environment and MCP
configuration. Changed settings or a dead process cause exact-handle resume.

Codex app-server does not expose `exec --ignore-user-config --ignore-rules`.
Its dedicated temporary `CODEX_HOME` contains only symlinks to the existing
`auth.json` and dedicated `sessions/unmute-agent` and
`archived_sessions/unmute-agent` subdirectories. Mapping the entire native
history makes a newly isolated server index every unrelated conversation
before initialize can answer; the dedicated subdirectories avoid that delay.
Exact-ID path lookup also supports resuming older Agent rollouts outside
these subdirectories, with the returned provider identity checked again.
It does not copy user config,
plugins, hooks or saved rules, and never edits the user's config or login.
Thread cwd remains the host's private Unmute runtime, not a user repository.
Native sessions remain accessible to the original CLI. Only the temporary
home is removed at process close. An auth.json login is required; keychain-only
authentication fails explicitly rather than selecting another provider or
silently inheriting a broader configuration.

The app host owns shutdown via the supervisor's dispose/close path. These
provider classes depend only on Node and can live in the background daemon.
