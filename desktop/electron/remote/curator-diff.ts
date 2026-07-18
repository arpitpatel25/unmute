// Unmute Remote — the Skill Curator's DETERMINISTIC unified line diff (D19).
//
// The raw diff a user sees for an UPDATE proposal is the "previous version vs
// new version" of a SKILL.md body. Per D19 it must be a pure function of the
// current on-disk body against the proposed body — NEVER LLM-generated, so it
// can never be plausible fiction. This module is that function: a minimal,
// correct LCS-based unified line diff with the standard `@@`/`+`/`-`/space
// format. Pure, no deps, no IO.

interface Op { type: ' ' | '-' | '+'; line: string; oldLn: number; newLn: number }

/** Split into lines for a line diff. Empty text → zero lines; a single trailing
 *  newline is stripped so "a\nb" and "a\nb\n" compare equal (a body that only
 *  gained/lost a trailing newline is not a real change to show). */
function splitLines(text: string): string[] {
  if (text === '') return []
  const t = text.endsWith('\n') ? text.slice(0, -1) : text
  return t.split('\n')
}

/** LCS-backtracked edit script: equal (' '), delete ('-'), insert ('+') ops in
 *  order, each annotated with the 1-based old/new line it sits at. */
function diffOps(a: string[], b: string[]): Op[] {
  const m = a.length
  const n = b.length
  // dp[i][j] = LCS length of a[i:] and b[j:].
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops: Op[] = []
  let i = 0
  let j = 0
  let oldLn = 1
  let newLn = 1
  const push = (type: Op['type'], line: string): void => {
    ops.push({ type, line, oldLn, newLn })
    if (type !== '+') oldLn++
    if (type !== '-') newLn++
  }
  while (i < m && j < n) {
    if (a[i] === b[j]) { push(' ', a[i]); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push('-', a[i]); i++ }
    else { push('+', b[j]); j++ }
  }
  while (i < m) { push('-', a[i]); i++ }
  while (j < n) { push('+', b[j]); j++ }
  return ops
}

/** A hunk range in `@@ start,count @@` form; count 1 drops the ",count" and
 *  count 0 keeps ",0" — exactly GNU `diff -u`'s convention. */
function fmtRange(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`
}

/**
 * A minimal, correct LCS-based unified line diff (default 3 lines of context).
 * Identical inputs → '' (empty string). Output has no trailing newline.
 */
export function unifiedDiff(oldText: string, newText: string, opts?: { context?: number }): string {
  const context = Math.max(0, opts?.context ?? 3)
  const ops = diffOps(splitLines(oldText), splitLines(newText))
  if (!ops.some((o) => o.type !== ' ')) return '' // no changes → empty diff

  // Mark, for each change op, a window of ±context ops as belonging to a hunk.
  // Adjacent/overlapping windows merge naturally into one contiguous run.
  const include = new Array<boolean>(ops.length).fill(false)
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].type === ' ') continue
    const lo = Math.max(0, k - context)
    const hi = Math.min(ops.length - 1, k + context)
    for (let d = lo; d <= hi; d++) include[d] = true
  }

  const out: string[] = []
  let s = 0
  while (s < ops.length) {
    if (!include[s]) { s++; continue }
    let e = s
    while (e + 1 < ops.length && include[e + 1]) e++
    const hunk = ops.slice(s, e + 1)

    const oldCount = hunk.filter((o) => o.type !== '+').length
    const newCount = hunk.filter((o) => o.type !== '-').length
    // A pure-insertion hunk (oldCount 0) anchors at the line BEFORE it; likewise
    // a pure-deletion hunk (newCount 0) on the new side — matching GNU diff.
    const oldStart = oldCount === 0 ? hunk[0].oldLn - 1 : hunk[0].oldLn
    const newStart = newCount === 0 ? hunk[0].newLn - 1 : hunk[0].newLn

    out.push(`@@ -${fmtRange(oldStart, oldCount)} +${fmtRange(newStart, newCount)} @@`)
    for (const o of hunk) out.push(`${o.type}${o.line}`)
    s = e + 1
  }
  return out.join('\n')
}
