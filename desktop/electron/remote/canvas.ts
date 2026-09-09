import type { Block } from './blocks'
import { CONTRACT_SENTINEL, stripCanvasContract } from './canvas-contract'

/**
 * THE CANVAS: a visual answer the agent drew, lifted out of its own prose.
 *
 * WHY A FENCE. The agent can only emit text — measured across the whole
 * transcript corpus, every image block in both harnesses sits in the USER role
 * (pasted files and tool results); an assistant message is text and nothing
 * else, and Codex's assistant output has exactly one part type, `output_text`.
 * So a visual answer has to arrive as text that DESCRIBES a picture, and a
 * fenced code block is the only container that survives both harnesses
 * untouched, needs no new wire format, and — this is the part that matters —
 * degrades to something legible if anything downstream does not understand it.
 * A build without the renderer shows a code block. Not a crash, not a blank.
 *
 * WHY IT IS STRIPPED FROM THE PROSE. The source is machinery, not an answer.
 * The pipeline already does exactly this for tool calls: raw JSON becomes a
 * `command` or `mcpCall` row rather than being printed. A canvas is the same
 * move. The transcript keeps the fence verbatim — replay, copy-as-text and
 * debugging all still see it — and only the RENDERED conversation loses it.
 *
 * WHY IT IS HOISTED. The picture belongs after the words, always, however the
 * model happened to interleave them. Two reasons, and the second is the real
 * one: a diagram between two paragraphs breaks the reading, and a person who
 * dictated the question may be listening rather than looking — so the spoken
 * answer has to be whole and uninterrupted before anything visual appears.
 */

/**
 * What a canvas block can hold. Deliberately small; each needs a renderer, and
 * an unrecognised format degrades to source-in-the-prose rather than a blank.
 *
 * NO MERMAID, and it was a close call. Mermaid is the obvious diagram format
 * and a model writes it more reliably than it hand-places SVG coordinates —
 * but the renderer is a 3.4MB JavaScript bundle that would have to be vendored
 * into the repo and carried in every DMG, for one of three formats. SVG needs
 * nothing at all, and `html` does everything mermaid does plus the interaction
 * a stepped explainer needs. Adding it later is a drop-in: a format string, a
 * bundled asset, one branch in CanvasWeb. Until then a ```unmute-canvas mermaid
 * fence stays in the prose as readable source, which is the honest failure.
 */
export type CanvasFormat = 'svg' | 'html'

const FORMATS: ReadonlySet<string> = new Set<CanvasFormat>(['svg', 'html'])

/**
 * How big one canvas may be, in characters of source.
 *
 * A cap rather than trust. The agent is spending the user's own tokens and a
 * runaway SVG is both expensive and unrenderable; refusing at the boundary is
 * cheaper than discovering it in a WebView. Generous enough for a real diagram
 * — the evaporation explainer that started this was under 2KB.
 */
export const CANVAS_MAX_CHARS = 16_000

/**
 * How many canvases one turn may show.
 *
 * One. A turn that draws six pictures has not answered the question, and the
 * surface it lands on is a notch panel, not a gallery. Extras are dropped
 * rather than queued: keeping them would mean a scroll region whose height
 * nobody budgeted for.
 */
export const CANVAS_MAX_PER_TURN = 1

/** Fetched pictures one turn may attach. See the note at the call site. */
export const IMAGES_MAX_PER_TURN = 3

/**
 * The opening fence.
 *
 * ```unmute-canvas mermaid
 *
 * The info string is OURS, not the language. ```mermaid alone would collide
 * with an agent legitimately showing someone mermaid source as code — in a
 * conversation about mermaid, every example would silently become a drawing.
 * The marker says "render this", and the format says how.
 */
const OPEN = /^[ \t]*```unmute-canvas[ \t]+([a-z]+)[ \t]*$/
const CLOSE = /^[ \t]*```[ \t]*$/

interface Found {
  readonly format: CanvasFormat
  readonly source: string
  /** Whether it was refused, and why — surfaced instead of silently dropped. */
  readonly tooLarge?: boolean
}

/**
 * Pull every canvas fence out of one message body.
 *
 * Returns the prose with the fences removed and the canvases in the order they
 * appeared. Line-based rather than a single greedy regex: a canvas can contain
 * ``` (an HTML canvas showing a code sample), and a regex spanning from the
 * first open to the last close would swallow the prose in between.
 */
export function extractCanvases(text: string): { text: string; found: Found[] } {
  if (!text.includes('```unmute-canvas')) return { text, found: [] }
  const lines = text.split('\n')
  const kept: string[] = []
  const found: Found[] = []
  let i = 0
  while (i < lines.length) {
    const open = OPEN.exec(lines[i])
    if (!open) { kept.push(lines[i]); i += 1; continue }
    const format = open[1]
    // Scan for the close. An UNCLOSED fence is not a canvas — the turn was
    // probably truncated mid-write — and the honest thing is to leave it in
    // the prose as a code block rather than render half a drawing or eat the
    // rest of the message.
    let end = -1
    for (let j = i + 1; j < lines.length; j += 1) {
      if (CLOSE.test(lines[j])) { end = j; break }
    }
    if (end === -1) { kept.push(lines[i]); i += 1; continue }
    const source = lines.slice(i + 1, end).join('\n')
    // An unrecognised format stays in the prose too. A future build may add
    // one, and an old build meeting it should show the source, not nothing.
    if (!FORMATS.has(format)) { kept.push(lines[i]); i += 1; continue }
    found.push(source.length > CANVAS_MAX_CHARS
      ? { format: format as CanvasFormat, source: '', tooLarge: true }
      : { format: format as CanvasFormat, source })
    i = end + 1
  }
  // Collapse the hole the fence left behind. Removing a block from between two
  // paragraphs leaves a run of blank lines that renders as a gap the size of
  // the thing that is no longer there.
  const prose = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return { text: prose, found }
}

/**
 * Lift canvases out of assistant messages and place them at the end of the turn.
 *
 * Applied to a finished block list rather than inside one extractor, because
 * the two harnesses do not share a reader — Claude has `blocks-claude.ts`,
 * Codex arrives through the task manager — and a rule about what the USER sees
 * should not be written twice in two dialects.
 *
 * A message that is ONLY a canvas leaves no empty bubble behind: an assistant
 * turn whose entire text was the fence would otherwise render as a blank row
 * above the drawing.
 */
/**
 * THE IMAGE TOOL'S HALF OF THE CONTRACT.
 *
 * A model cannot emit an image — measured across the whole corpus, every image
 * block in both harnesses sits in the user role, and an assistant message is
 * text. What it CAN do is fetch a real one to disk with its ordinary tools and
 * tell us where it put it. So the image tool asks for a path on its own line:
 *
 *     unmute-image: /absolute/path/to/file.png
 *
 * A LINE, NOT A FENCE, because unlike a drawing this is not source — there is
 * nothing to render, only a file to point at. It becomes an `attachment` block,
 * which the surface already draws as a real thumbnail with a click-to-preview.
 * No new renderer, no new store.
 */
const IMAGE_LINE = /^[ \t]*unmute-image:[ \t]*(\S.*?)[ \t]*$/
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i

/** The tile decides how to draw from the mime type, so it has to be right. */
function mimeForPath(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  return 'image/png'
}

export function extractImages(text: string): { text: string; paths: string[] } {
  if (!text.includes('unmute-image:')) return { text, paths: [] }
  const kept: string[] = []
  const paths: string[] = []
  for (const line of text.split('\n')) {
    const found = IMAGE_LINE.exec(line)
    // ABSOLUTE PATHS ONLY, and only ones that look like an image. A relative
    // path has no meaning here — the surface has no working directory — and a
    // line that is not a real image reference is far more likely to be the
    // model talking about the feature than using it, so it stays in the prose.
    if (found && found[1].startsWith('/') && IMAGE_EXT.test(found[1])) paths.push(found[1])
    else kept.push(line)
  }
  return { text: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(), paths }
}

export function liftCanvases(blocks: readonly Block[]): Block[] {
  const touches = (b: Block): boolean => b.kind !== 'message' ? false
    : b.role === 'user' ? b.text.startsWith(CONTRACT_SENTINEL)
    : (b.text.includes('```unmute-canvas') || b.text.includes('unmute-image:'))
  if (!blocks.some(touches)) return [...blocks]
  const out: Block[] = []
  let pending: Block[] = []
  let drawn = 0
  // THE SAME DRAWING TWICE IS ONE DRAWING.
  //
  // Identity is the SOURCE, and the scope is the whole conversation rather than
  // the turn. Measured on a real task: Claude's frame stream carried the final
  // reply twice — once as a proper assistant message and once as a shapeless
  // duplicate with no uuid and no role — and a `turnEnd` sat between them, so
  // the per-turn cap below reset and rendered the water cycle twice, one card
  // under the other.
  //
  // Deduplicating on content rather than on frame identity is deliberate: it
  // does not care WHY the transport repeated itself, and it survives a replay,
  // a resume, or a rebuild that re-emits an earlier turn. A genuinely new
  // drawing has different source and still renders.
  const seen = new Set<string>()

  const flush = (): void => {
    if (!pending.length) return
    out.push(...pending)
    pending = []
  }

  for (const block of blocks) {
    // A turn boundary is where the pending canvases land — after every word of
    // the turn, before the surface moves on.
    if (block.kind === 'turnEnd') { flush(); out.push(block); drawn = 0; continue }
    if (block.kind === 'turnStart') { out.push(block); drawn = 0; continue }
    // THE CONTRACT COMES BACK OFF THE PERSON'S OWN MESSAGE. It travelled
    // inside their turn, so the transcript records it as something they said;
    // left alone it renders as a wall of instructions in their bubble, above
    // the answer. Same machinery as the agent's fences, hidden the same way,
    // and the transcript still holds it verbatim for replay and debugging.
    if (block.kind === 'message' && block.role === 'user') {
      const spoken = stripCanvasContract(block.text)
      out.push(spoken === block.text ? block : { ...block, text: spoken })
      continue
    }
    if (block.kind !== 'message' || block.role !== 'assistant') { out.push(block); continue }

    const withoutImages = extractImages(block.text)
    const { text, found } = extractCanvases(withoutImages.text)
    if (!found.length && !withoutImages.paths.length) { out.push(block); continue }
    if (text) out.push({ ...block, text })
    // A FETCHED IMAGE IS AN ATTACHMENT, drawn by the tile that already exists.
    // It joins the same pending queue as a drawing so it lands after the words
    // for the same reason: the reply must be complete for someone listening.
    // CAPPED LIKE THE DRAWINGS ARE. The contract asks for one; three is the
    // allowance before a reply stops being an answer and becomes a gallery,
    // and an uncapped list would let a single turn fill the panel with files
    // the user never asked for.
    for (const path of withoutImages.paths.slice(0, IMAGES_MAX_PER_TURN)) {
      // Same duplicate-transport problem, same answer: one file is one picture.
      if (seen.has(`image:${path}`)) continue
      seen.add(`image:${path}`)
      pending.push({
        kind: 'attachment',
        role: 'assistant',
        path,
        name: path.split('/').pop() || 'image',
        mimeType: mimeForPath(path),
      })
    }
    for (const canvas of found) {
      if (drawn >= CANVAS_MAX_PER_TURN) break
      const key = `${canvas.format}:${canvas.source}`
      if (!canvas.tooLarge && seen.has(key)) continue
      seen.add(key)
      drawn += 1
      pending.push(canvas.tooLarge
        ? { kind: 'error', message: `A drawing was too large to show (over ${Math.round(CANVAS_MAX_CHARS / 1000)}k characters).` }
        : { kind: 'canvas', format: canvas.format, source: canvas.source })
    }
  }
  flush()
  return out
}
