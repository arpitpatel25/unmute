/**
 * CODEX CLI — what unmute's settings mean in Codex's vocabulary.
 *
 * Two products, two vocabularies, and the translation has to be written down
 * somewhere. Written down HERE, once, because the alternative is what shipped:
 * unmute read `permissionMode: auto-approve`, handed Claude
 * `--dangerously-skip-permissions`, and handed Codex nothing at all. The
 * setting was read and then dropped on the floor for one backend.
 *
 * CODEX SEPARATES TWO THINGS CLAUDE CONFLATES, and that is the interesting part.
 *
 *   approval policy — does it stop and ask you
 *   sandbox         — what it can reach even when it does not ask
 *
 * Claude Code has one dial: `--dangerously-skip-permissions` removes the asking
 * AND the boundary together, and there is no way to say "don't interrupt me,
 * but stay in the project". Codex can say exactly that, so unmute's own path
 * fence (`sandboxRoots`) becomes real for Codex in a way it cannot be for
 * Claude.
 *
 * THE FENCE IS NOT DECORATION. `sandboxRoots` is a user-facing control on the
 * Remote screen. With Codex hardcoded to full access it would have gone on
 * rendering while doing nothing — a switch the user sets, Claude honours, and
 * Codex walks straight through, with nothing saying so. That is the exact shape
 * of every bug this branch has been fixing, so it is a mapping and not a
 * constant.
 */

/** unmute's two-value setting. */
export type PermissionMode = 'prompt' | 'auto-approve'

export interface CodexPosture {
  /** `thread/start` approvalPolicy. */
  approvalPolicy: 'untrusted' | 'on-request' | 'never'
  /** `thread/start` sandbox. */
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** Extra writable roots, for the fenced case. Empty when unfenced. */
  addDirs: string[]
  /** True when this posture grants the whole machine — the thing a consent
   *  prompt is about, and the thing a surface should be able to show. */
  fullAccess: boolean
}

/**
 * The posture for one task.
 *
 * FENCE WINS OVER CONVENIENCE. If the user has named allowed roots, they have
 * asked for a boundary, and "auto-approve" then means "don't interrupt me
 * inside it" rather than "ignore what I said". Claude's adapter already reads
 * it this way — a sandboxed Claude task does NOT get
 * --dangerously-skip-permissions — so this keeps the two backends answering to
 * the same switch.
 */
export function codexPosture(o: {
  permissionMode: PermissionMode
  sandboxRoots?: readonly string[]
  /** Set false to refuse full access even when nothing is fenced — the consent
   *  gate. Absent means consent was given. */
  fullAccessAllowed?: boolean
}): CodexPosture {
  const roots = (o.sandboxRoots ?? []).filter((r) => !!r && r.trim().length > 0)
  const auto = o.permissionMode === 'auto-approve'
  const consented = o.fullAccessAllowed !== false

  if (roots.length) {
    return {
      // Inside a fence, auto-approve means "work without stopping me". The
      // sandbox is doing the containing, so the approvals are the only thing
      // left to turn off.
      approvalPolicy: auto ? 'never' : 'on-request',
      sandbox: 'workspace-write',
      addDirs: [...roots],
      fullAccess: false,
    }
  }

  if (auto && consented) {
    return { approvalPolicy: 'never', sandbox: 'danger-full-access', addDirs: [], fullAccess: true }
  }

  // NO CONSENT YET, OR THE USER WANTS TO BE ASKED. Codex's own defaults —
  // workspace-write with approvals on request — which is what a person gets
  // when they type `codex` themselves. Never a posture stronger than the user
  // has agreed to.
  return {
    approvalPolicy: auto ? 'never' : 'on-request',
    sandbox: 'workspace-write',
    addDirs: [],
    fullAccess: false,
  }
}

/** One line for a consent prompt or a settings row. Says what is actually
 *  granted rather than naming Codex's enum values at the user. */
export function describePosture(p: CodexPosture): string {
  const reach = p.sandbox === 'danger-full-access' ? 'your whole Mac, including the network'
    : p.addDirs.length ? `the task folder and ${p.addDirs.length} allowed director${p.addDirs.length === 1 ? 'y' : 'ies'}`
      : 'the task folder'
  const asks = p.approvalPolicy === 'never' ? 'without asking' : 'asking before anything outside it'
  return `Can reach ${reach}, ${asks}.`
}
