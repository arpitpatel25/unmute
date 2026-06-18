// Unmute Remote — tiny dependency-free markdown renderer for task `result.detail`.
//
// The executor writes info answers as markdown; we render it properly (headings,
// bold, lists, links, inline code, paragraphs) instead of showing raw syntax.
// Inherits the parent's text color so it works on both the dark overlay and the
// light in-app panel. Intentionally small — not a full CommonMark engine, just
// the constructs an answer actually uses.

import type { ReactNode } from 'react'

type API = { remoteOpenArtifact?: (type: 'url' | 'path', value: string) => Promise<boolean> }
function openUrl(href: string) {
  const fn = (window as unknown as { electronAPI?: API }).electronAPI?.remoteOpenArtifact
  if (fn) void fn('url', href)
}

// Inline spans: **bold**, `code`, [text](url).
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    if (m[2] !== undefined) {
      out.push(<strong key={`${keyBase}-b${i}`} className="font-semibold">{m[2]}</strong>)
    } else if (m[4] !== undefined) {
      out.push(<code key={`${keyBase}-c${i}`} className="px-1 py-0.5 rounded bg-zinc-500/20 font-mono text-[0.92em]">{m[4]}</code>)
    } else if (m[6] !== undefined) {
      out.push(
        <a
          key={`${keyBase}-l${i}`}
          href={m[7]}
          className="underline text-sky-500 hover:text-sky-400"
          onClick={(e) => { e.preventDefault(); openUrl(m![7]) }}
        >{m[6]}</a>,
      )
    }
    last = re.lastIndex
    i++
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function Markdown({ text }: { text: string }) {
  const lines = (text || '').replace(/\r/g, '').split('\n')
  const blocks: ReactNode[] = []
  let para: string[] = []
  let k = 0
  let i = 0

  const flushPara = () => {
    if (para.length) {
      blocks.push(<p key={`p${k++}`} className="mb-1.5 leading-relaxed">{inline(para.join(' '), `p${k}`)}</p>)
      para = []
    }
  }

  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*$/.test(line)) { flushPara(); i++; continue }

    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      flushPara()
      const lvl = h[1].length
      const cls = lvl <= 2 ? 'text-[1.05em] font-semibold mt-2 mb-1' : 'text-[0.98em] font-semibold mt-1.5 mb-0.5'
      blocks.push(<div key={`h${k++}`} className={cls}>{inline(h[2], `h${k}`)}</div>)
      i++
      continue
    }

    if (/^\s*[-*]\s+/.test(line)) {
      flushPara()
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, '')); i++ }
      blocks.push(<ul key={`u${k++}`} className="list-disc pl-4 mb-1.5 space-y-0.5">{items.map((it, j) => <li key={j}>{inline(it, `u${k}-${j}`)}</li>)}</ul>)
      continue
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      flushPara()
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++ }
      blocks.push(<ol key={`o${k++}`} className="list-decimal pl-4 mb-1.5 space-y-0.5">{items.map((it, j) => <li key={j}>{inline(it, `o${k}-${j}`)}</li>)}</ol>)
      continue
    }

    para.push(line)
    i++
  }
  flushPara()
  return <div>{blocks}</div>
}
