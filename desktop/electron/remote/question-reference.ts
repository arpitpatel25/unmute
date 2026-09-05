export type QuestionReference = { requestId: string; stepId: string }
/** null is an explicitly captured new turn, never an answer to a later ask. */
export type AnswerContext = QuestionReference | null
export function sameQuestion(a: QuestionReference | undefined | null, b: QuestionReference | undefined | null): boolean {
  return !!a && !!b && typeof a.requestId === 'string' && typeof a.stepId === 'string' && a.requestId === b.requestId && a.stepId === b.stepId
}
