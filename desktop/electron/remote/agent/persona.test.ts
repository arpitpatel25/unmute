import test from 'node:test'
import assert from 'node:assert/strict'
import { loadPersona, personaPath, PERSONA_FILENAME } from './persona'
import { AGENT_PRINCIPLES } from './constitution'

function io(files: Record<string, string>) {
  const written: Record<string, string> = {}
  return {
    written,
    readFile: async (p: string) => {
      if (!(p in files)) throw new Error('ENOENT')
      return files[p]
    },
    writeFile: async (p: string, data: string) => { written[p] = data; files[p] = data },
    mkdir: async () => {},
  }
}

test('first run seeds the file from the built-in default', async () => {
  const fs = io({})
  const out = await loadPersona('/agent', fs)
  assert.equal(out.source, 'seeded')
  assert.equal(out.text, AGENT_PRINCIPLES)
  assert.ok(fs.written[personaPath('/agent')].includes(AGENT_PRINCIPLES))
})

test('an existing file IS the prompt, verbatim', async () => {
  // NEVER MERGED, NEVER MIGRATED: quietly appending our newer paragraphs to a
  // file the user has edited makes their copy drift into something neither of
  // us wrote.
  const fs = io({ [personaPath('/agent')]: 'You are terse. Say less.' })
  const out = await loadPersona('/agent', fs)
  assert.equal(out.source, 'file')
  assert.equal(out.text, 'You are terse. Say less.')
  assert.deepEqual(fs.written, {}, 'an existing file is never rewritten')
})

test('the explanatory header is for the reader, not the model', async () => {
  const fs = io({ [personaPath('/agent')]: '<!-- how to edit this -->\n\nBe brief.' })
  const out = await loadPersona('/agent', fs)
  assert.equal(out.text, 'Be brief.')
})

test('an empty file is treated as no file', async () => {
  const fs = io({ [personaPath('/agent')]: '   \n' })
  const out = await loadPersona('/agent', fs)
  assert.equal(out.source, 'seeded')
})

test('a disk that will not cooperate still gives a working Agent', async () => {
  // A read or write failure must not be the reason the Agent cannot answer.
  const out = await loadPersona('/agent', {
    readFile: async () => { throw new Error('EACCES') },
    writeFile: async () => { throw new Error('EROFS') },
    mkdir: async () => { throw new Error('EROFS') },
  })
  assert.equal(out.source, 'default')
  assert.equal(out.text, AGENT_PRINCIPLES)
})

test('the file is named so a human can find it', () => {
  assert.equal(PERSONA_FILENAME, 'unmute-agent.md')
})

/**
 * FIELD FAILURE (2026-09-16): an untouched copy of the rules froze on the day
 * it was seeded. This machine ran 8 September's rules for eight days, through
 * every change since, including a new tool's rules that never arrived.
 */
test('an untouched copy from an earlier build is refreshed to today\'s rules', async () => {
  const { LEGACY_DEFAULT_FINGERPRINTS } = await import('./persona-defaults')
  assert.ok(LEGACY_DEFAULT_FINGERPRINTS.size > 0)
  // Simulate an old seed: a body whose fingerprint is on the legacy list.
  const { createHash } = await import('node:crypto')
  const old = 'You are the Unmute Agent. (an older rulebook)'
  const fingerprint = createHash('sha256').update(old).digest('hex').slice(0, 16)
  const fs = io({ [personaPath('/agent')]: `<!-- header -->\n${old}\n` })
  const out = await loadPersona('/agent', fs, new Set([fingerprint]))
  assert.equal(out.source, 'refreshed')
  assert.equal(out.text, AGENT_PRINCIPLES)
  assert.ok(fs.written[personaPath('/agent')].includes(AGENT_PRINCIPLES), 'the file itself now holds today\'s rules')
})

test('a copy seeded with a fingerprint is refreshed when the shipped rules change', async () => {
  const fs = io({})
  await loadPersona('/agent', fs)
  const seeded = fs.written[personaPath('/agent')]
  assert.match(seeded, /unmute-default: [0-9a-f]{16}/, 'new seeds record what they were seeded from')
  // Pretend the build that wrote it shipped different rules.
  const older = seeded.replace(AGENT_PRINCIPLES, 'An older rulebook.')
    .replace(/unmute-default: [0-9a-f]{16}/, `unmute-default: ${(await import('node:crypto')).createHash('sha256').update('An older rulebook.').digest('hex').slice(0, 16)}`)
  const again = io({ [personaPath('/agent')]: older })
  const out = await loadPersona('/agent', again)
  assert.equal(out.source, 'refreshed')
  assert.equal(out.text, AGENT_PRINCIPLES)
})

test('a copy a person edited is never refreshed, seeded fingerprint or not', async () => {
  const fs = io({})
  await loadPersona('/agent', fs)
  const edited = fs.written[personaPath('/agent')].replace(AGENT_PRINCIPLES, `${AGENT_PRINCIPLES}\nAlways answer in French.`)
  const again = io({ [personaPath('/agent')]: edited })
  const out = await loadPersona('/agent', again)
  assert.equal(out.source, 'file')
  assert.match(out.text, /Always answer in French/)
  assert.deepEqual(again.written, {})
})

test('an untouched copy is refreshed even when the disk will not take the write', async () => {
  const { createHash } = await import('node:crypto')
  const old = 'An older rulebook.'
  const fingerprint = createHash('sha256').update(old).digest('hex').slice(0, 16)
  const out = await loadPersona('/agent', {
    readFile: async () => old,
    writeFile: async () => { throw new Error('EROFS') },
    mkdir: async () => {},
  }, new Set([fingerprint]))
  assert.equal(out.source, 'refreshed')
  assert.equal(out.text, AGENT_PRINCIPLES)
})

/** The log line that answers "which rules is this Agent running?" on any
 *  machine, without reading its files (asked for on 2026-09-17). */
test('what the Agent loaded is described in one comparable line', async () => {
  const { describeRules } = await import('./persona')
  const seeded = describeRules(await loadPersona('/agent', io({})))
  assert.equal(seeded.source, 'seeded')
  assert.equal(seeded.current, true, 'a fresh seed is the shipped rulebook')
  assert.equal(seeded.loaded, seeded.shipped)
  assert.match(seeded.loaded, /^[0-9a-f]{16}$/)

  const edited = describeRules(await loadPersona('/agent', io({ [personaPath('/agent')]: 'Be brief.' })))
  assert.equal(edited.source, 'file')
  assert.equal(edited.current, false, 'an edited file is visibly not the shipped rules')
  assert.equal(edited.chars, 'Be brief.'.length)
})
