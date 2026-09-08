/** Provider-authored envelopes in the user role are not human prompts. */
export function isClaudeSyntheticPrompt(text: string): boolean {
  return /^(?:<task-notification[\s>]|<system-reminder[\s>]|<local-command-|<command-name>|Caveat:|\[Request interrupted by user|This session is being continued from a previous|Base directory for this skill:)/.test(text.trimStart())
}
