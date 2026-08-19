/**
 * Runner for the Agent behaviour evals. Opt-in: `npm run eval:agent`.
 *
 * Cases run concurrently but bounded, because each one spawns a real CLI turn.
 * Exit code is non-zero when any case fails, so this can be wired into CI when
 * someone decides the per-run cost is worth paying — that is a spending
 * decision, not a technical one, so it is deliberately not wired in already.
 */
import { CORPUS } from './corpus'
import { runTurn } from './harness'

const CONCURRENCY = 3

interface Verdict { name: string; failure: string | null; ms: number }

async function runCase(index: number): Promise<Verdict> {
  const testCase = CORPUS[index]!
  const started = Date.now()
  try {
    const { calls, reply } = await runTurn(testCase.utterance, testCase.behaviour ?? {})
    return { name: testCase.name, failure: testCase.check(calls, reply), ms: Date.now() - started }
  } catch (error) {
    return { name: testCase.name, failure: `harness error: ${(error as Error).message}`, ms: Date.now() - started }
  }
}

async function main(): Promise<void> {
  const only = process.argv[2]
  const indices = CORPUS
    .map((testCase, index) => ({ testCase, index }))
    .filter(({ testCase }) => !only || testCase.name.includes(only))
    .map(({ index }) => index)

  if (indices.length === 0) {
    console.error(`no eval matches "${only}"`)
    process.exit(2)
  }
  console.log(`running ${indices.length} agent evals (real model, real schemas)\n`)

  const verdicts: Verdict[] = []
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, indices.length) }, async () => {
    for (;;) {
      const next = cursor++
      if (next >= indices.length) return
      const verdict = await runCase(indices[next]!)
      verdicts.push(verdict)
      const mark = verdict.failure ? 'FAIL' : 'pass'
      console.log(`${mark}  ${verdict.name}  (${(verdict.ms / 1000).toFixed(1)}s)`)
      if (verdict.failure) console.log(`      ${verdict.failure}`)
    }
  }))

  const failed = verdicts.filter((verdict) => verdict.failure)
  console.log(`\n${verdicts.length - failed.length}/${verdicts.length} passed`)
  if (failed.length > 0) {
    console.log('\nfailures exist because a rule lives only in the prompt.')
    console.log('consider whether each one can move into the tool schema instead.')
  }
  process.exit(failed.length > 0 ? 1 : 0)
}

void main()
