// groupSections — the pure math behind the wall's group headers.
//
// Contract (spec 2026-07-16-cockpit-grouping): groups are creatures of the
// present — the section list is derived from exactly the tasks on screen,
// nothing else. Input order is preserved inside a section (the store is
// newest-first, so newest renders left). Named sections order by their most
// recently touched member (most active stream on top); ungrouped tasks come
// last. With zero named groups the wall renders exactly as before — one
// unnamed section, no headers, no ceremony.
// Pure module: no React, no electron — unit-tested by groupSections.test.ts.

export interface GroupSection<T> {
  /** null = the ungrouped section (render without a header when alone). */
  name: string | null
  tasks: T[]
}

export function groupSections<T extends { group?: string | null; updatedAt: number }>(
  tasks: T[],
): Array<GroupSection<T>> {
  const named = new Map<string, T[]>()
  const ungrouped: T[] = []
  for (const t of tasks) {
    const g = (t.group ?? '').trim()
    if (!g) { ungrouped.push(t); continue }
    const bucket = named.get(g)
    if (bucket) bucket.push(t)
    else named.set(g, [t])
  }
  if (named.size === 0) return tasks.length || ungrouped.length ? [{ name: null, tasks: ungrouped }] : []
  const sections: Array<GroupSection<T>> = [...named.entries()]
    .map(([name, ts]) => ({ name: name as string | null, tasks: ts }))
    .sort((a, b) => Math.max(...b.tasks.map((t) => t.updatedAt)) - Math.max(...a.tasks.map((t) => t.updatedAt)))
  if (ungrouped.length) sections.push({ name: null, tasks: ungrouped })
  return sections
}
