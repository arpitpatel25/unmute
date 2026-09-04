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
