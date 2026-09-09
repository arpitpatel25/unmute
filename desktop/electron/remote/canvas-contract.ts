/**
 * WHAT A VISUAL TOOL TELLS THE AGENT, and nothing else does.
 *
 * WHY THIS IS PROSE IN A CONSTANT rather than a skill. Skills are a Claude
 * Code feature; Codex has no equivalent, and this product is provider-agnostic
 * by design — a mechanism that works on one lane and not the other is a
 * feature that silently does nothing for half the users. A prefix on the
 * delivered text works identically on both, needs no registration, and cannot
 * fire on its own: it is present only when the person armed a tool.
 *
 * WHY IT IS SO INSISTENT ABOUT THE WORDS COMING FIRST. This is a voice product.
 * Someone can arm a tool, dictate a question, and walk away — the answer is
 * read aloud and the picture is not. A reply that says "see the diagram below"
 * is, for that person, no reply at all. So the contract is not "draw instead of
 * explaining", it is "explain, then draw", and it says so twice because a model
 * that has just been handed a canvas is strongly inclined to use it as the
 * whole answer.
 */

export type CanvasTool = 'diagram' | 'interactive' | 'image'

export const CANVAS_TOOLS: ReadonlySet<string> = new Set<CanvasTool>(['diagram', 'interactive', 'image'])

/**
 * THE FIRST LINE OF EVERY CONTRACT, and the handle the surface strips it by.
 *
 * The contract is delivered as part of the user's turn, which means it also
 * arrives back in the transcript as something the user apparently SAID — and it
 * rendered that way: a wall of instructions in the person's own message bubble,
 * above the answer. It is machinery, exactly like the fences the agent writes
 * back, and it gets hidden for exactly the same reason.
 *
 * Exported so the stripper and the contract cannot drift; a sentinel that lives
 * in two files is one edit away from leaving the wall on screen again.
 */
export const CONTRACT_SENTINEL = 'The person has asked for a visual answer using an unmute tool.'

/** What separates the contract from the person's own words. */
export const CONTRACT_SEPARATOR = '\n\n---\n\n'

/** Shared by every tool: the rules that are about the ANSWER, not the drawing. */
const PREAMBLE = `${CONTRACT_SENTINEL} Follow these rules exactly.

ANSWER IN WORDS FIRST, COMPLETELY. They may have dictated this question and may be listening rather than looking. Your written answer has to stand entirely on its own — someone who never sees the picture must still have the whole answer. Never write "see the diagram below", never make the visual carry a step the words skipped.

THEN draw, once, at the end.`

const FENCE = `Put it in a fenced block with this exact opening line, and nothing else on that line:

\`\`\`unmute-canvas FORMAT
...source...
\`\`\`

The block is lifted out of your message and rendered as a card beneath your reply, so do not describe it, introduce it, or refer to where it sits. One block per reply. If you cannot produce something genuinely useful, say so in words and draw nothing — an empty or decorative picture is worse than none.`

const SANDBOX = `IT RUNS SEALED. No network of any kind: no remote scripts, stylesheets, fonts, or images, and no fetch. Everything must be self-contained in the source you write. Nothing persists between renders. Links are not followed. Colours must work on a DARK background (the card is near-black; use light strokes and text, and never rely on a white canvas). Keep it under 16000 characters.`

const RESPONSIVE = `IT MUST FIT ANY WIDTH. The panel is resizable and can be narrow. Give an <svg> a viewBox and no fixed width/height attributes so it scales; let HTML flow rather than positioning at absolute pixel offsets. Do not assume a specific size.`

const TOOLS: Record<CanvasTool, string> = {
  diagram: `${PREAMBLE}

Draw ONE diagram as an SVG. Use format \`svg\`.

${FENCE.replace('FORMAT', 'svg')}

${SANDBOX}

${RESPONSIVE}

A diagram earns its place by showing STRUCTURE the sentences cannot: how parts connect, what flows where, how something is laid out, how a quantity compares. If the answer is a list or a sequence of sentences, it is not a diagram — say so and draw nothing. Label everything in the drawing; an unlabelled box is decoration. Prefer a handful of clear shapes over a dense schematic.`,

  interactive: `${PREAMBLE}

Build ONE small self-contained page the person can interact with. Use format \`html\`.

${FENCE.replace('FORMAT', 'html')}

${SANDBOX} Inline <style> and <script> are allowed and are the only way to include either.

${RESPONSIVE}

Use this when the point is something that CHANGES: stepping through stages, toggling a variable, comparing before and after. A stepped explainer — Prev/Next through several frames — is the usual shape, and is how to show motion; do not attempt video. If nothing in the answer actually changes, use a still diagram instead.`,

  image: `${PREAMBLE}

Find ONE real image that genuinely helps, download it, and attach it.

Use your ordinary tools to fetch it to a file on disk, then state the absolute path on its own line in the form:

unmute-image: /absolute/path/to/file.png

Rules. Only a real image that already exists on the web — you cannot generate one, and must not pretend to. It must be directly relevant to the answer, not decorative. Prefer a source that permits reuse, and name the source in your written answer. PNG, JPEG or WebP; nothing larger than about 5 MB. If you cannot find one that genuinely helps, say so plainly and attach nothing — that is a perfectly good outcome and better than an irrelevant picture.`,
}

/**
 * The instruction for an armed tool, or null.
 *
 * Returns null for an unknown value rather than throwing: an older host meeting
 * a tool a newer surface armed should send the person's words unchanged, which
 * is a message that works, instead of failing the send outright.
 */
export function canvasContract(tool: string | undefined): string | null {
  if (!tool || !CANVAS_TOOLS.has(tool)) return null
  return TOOLS[tool as CanvasTool]
}

/**
 * The delivered text for a turn, with the contract in front of the person's own
 * words.
 *
 * THE ORDER MATTERS AND IS NOT NEGOTIABLE. Instructions first, the person's
 * words last, separated by a rule the model can see. The person's sentence is
 * the request; everything above it is how to dress the answer. Putting the
 * contract after would make the last thing the model reads a paragraph of
 * process, and the request becomes context for the instructions instead of the
 * other way round.
 */
export function withCanvasContract(text: string, tool: string | undefined): string {
  const contract = canvasContract(tool)
  return contract ? `${contract}${CONTRACT_SEPARATOR}${text}` : text
}

/**
 * The person's own words, with an armed tool's instructions taken back off.
 *
 * WHY THIS HAS TO EXIST. The contract rides along inside the user's turn, so
 * the transcript records it as something they said — and the conversation drew
 * it that way: several hundred words of rules sitting in their message bubble
 * above the reply. The agent's fences are hidden for being machinery; this is
 * the same machinery arriving from the other direction and it is hidden the
 * same way.
 *
 * CONSERVATIVE ON PURPOSE. Only a message that BEGINS with the sentinel and
 * contains the separator is touched, and only the first separator is used — so
 * a person who writes `---` in their own message loses nothing, and a message
 * that merely quotes the sentinel is left alone.
 */
export function stripCanvasContract(text: string): string {
  if (!text.startsWith(CONTRACT_SENTINEL)) return text
  const cut = text.indexOf(CONTRACT_SEPARATOR)
  return cut === -1 ? text : text.slice(cut + CONTRACT_SEPARATOR.length)
}
