// Unmute Remote — contract installer (PRD decision #3).
//
// Installs the stable operating contract (contract.md) where Claude Code
// auto-loads it: as a CLAUDE.md in the per-task session working directory.
//
// Why the per-task cwd: Unmute owns that directory (~/.unmute/remote/<u>/<id>/),
// so there's zero risk of clobbering the user's own project CLAUDE.md (PRD #3
// concern). We still upsert via markers so the function is safe even if pointed
// at a shared/existing CLAUDE.md in the future.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '../log'
import { CONTRACT_TEXT, CONTRACT_BEGIN, CONTRACT_END } from './contract-text'

const log = createLogger('contract-installer')

export { CONTRACT_BEGIN, CONTRACT_END }

/** The bundled contract text (survives electron-vite bundling — see contract-text.ts). */
export async function readContractText(): Promise<string> {
  return CONTRACT_TEXT.trim()
}

/**
 * Upsert the contract block into an existing CLAUDE.md body. Pure string op so
 * it's unit-testable: replaces an existing marked block, else appends one.
 * Preserves all non-contract content (idempotent).
 */
export function upsertContractBlock(existingBody: string, contractBlock: string): string {
  const begin = existingBody.indexOf(CONTRACT_BEGIN)
  const end = existingBody.indexOf(CONTRACT_END)
  if (begin !== -1 && end !== -1 && end > begin) {
    const before = existingBody.slice(0, begin)
    const after = existingBody.slice(end + CONTRACT_END.length)
    return (before + contractBlock + after).trim() + '\n'
  }
  const sep = existingBody.trim() ? existingBody.trim() + '\n\n' : ''
  return (sep + contractBlock).trim() + '\n'
}

/**
 * Install/refresh the contract as CLAUDE.md inside `cwd`. Returns the path.
 */
export async function installContract(cwd: string): Promise<string> {
  await fs.mkdir(cwd, { recursive: true })
  const target = join(cwd, 'CLAUDE.md')
  const contract = await readContractText()
  let existing = ''
  try {
    existing = await fs.readFile(target, 'utf8')
  } catch {
    /* fresh file */
  }
  const next = upsertContractBlock(existing, contract)
  await fs.writeFile(target, next, 'utf8')
  log.event('contract-installed', { target, bytes: next.length, refreshed: existing.length > 0 })
  return target
}
