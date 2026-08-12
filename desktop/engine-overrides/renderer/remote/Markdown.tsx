// Unmute Orchestrator — agent prose, rendered by a real markdown engine.
//
// This was a hand-rolled renderer. It grew tables and inline-code chips, but
// printed ``` fences literally and flattened nested lists — while the notch's
// SEPARATE hand-rolled renderer had fences and nesting but could not see tables
// at all. Two independent approximations of CommonMark, each missing a different
// half. That is the argument for parsing with something real rather than
// extending either: remark-gfm here, cmark-gfm (via swift-markdown) in the notch.
//
// What stays hand-written is the part that should be — the styling, and the
// decision about what a link IS (see linkGlyph.ts: scheme and path shape, never
// a table of brands).
//
// Inherits the parent's text colour so it works on both the dark overlay and the
// light in-app panel.

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { linkKind, localPath, type LinkKind } from './linkGlyph'

type API = { remoteOpenArtifact?: (type: 'url' | 'path', value: string) => Promise<boolean> }

/// A link opens where the user works, never inside the panel — this surface has
/// nowhere to navigate back from.
function openHref(href: string) {
  const fn = (window as unknown as { electronAPI?: API }).electronAPI?.remoteOpenArtifact
  if (!fn) return
  const path = localPath(href)
  void fn(path === null ? 'url' : 'path', path ?? href)
}

// House style: 16px box, currentColor stroke, 1.75 round caps — matching the
// glyphs already in RemoteSettings.tsx.
function Glyph({ kind }: { kind: LinkKind }) {
  const d: Record<LinkKind, string> = {
    web: 'M6.5 9.5a3 3 0 0 0 4.2 0l2.1-2.1a3 3 0 0 0-4.2-4.2l-1 1M9.5 6.5a3 3 0 0 0-4.2 0L3.2 8.6a3 3 0 0 0 4.2 4.2l1-1',
    file: 'M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10A1.5 1.5 0 0 0 4.5 14.5h7A1.5 1.5 0 0 0 13 13V5.5L9 1.5ZM9 1.5V5.5H13',
    folder: 'M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 2h4.5A1.5 1.5 0 0 1 14 6.5v5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7Z',
    image: 'M3 3h10v10H3V3Zm0 7.5 3-3 2.5 2.5L11 7.5l2 2M6 6.5a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z',
    mail: 'M2 4.5h12v7H2v-7Zm0 .5 6 4 6-4',
    phone: 'M5.5 2.5 7 5.5 5.5 7a7 7 0 0 0 3.5 3.5L10.5 9l3 1.5v2.5a1 1 0 0 1-1 1A10.5 10.5 0 0 1 2 3.5a1 1 0 0 1 1-1h2.5Z',
  }
  return (
    <svg
      width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
      className="inline-block shrink-0 align-[-0.1em] mr-[0.25em] opacity-80"
      aria-hidden="true"
    >
      <path d={d[kind]} />
    </svg>
  )
}

/// react-markdown v9 sanitises hrefs and WOULD STRIP LOCAL PATHS — which are
/// exactly the file links we want to render as chips. So the transform is
/// explicit: keep everything that is not an executable scheme.
function urlTransform(url: string): string {
  return /^\s*(javascript|data|vbscript):/i.test(url) ? '' : url
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="[&>*:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={urlTransform}
        components={{
          p: ({ children }) => <p className="mb-1.5 leading-relaxed">{children}</p>,
          h1: ({ children }) => <div className="text-[1.05em] font-semibold mt-2 mb-1">{children}</div>,
          h2: ({ children }) => <div className="text-[1.05em] font-semibold mt-2 mb-1">{children}</div>,
          h3: ({ children }) => <div className="text-[0.98em] font-semibold mt-1.5 mb-0.5">{children}</div>,
          h4: ({ children }) => <div className="text-[0.98em] font-semibold mt-1.5 mb-0.5">{children}</div>,
          h5: ({ children }) => <div className="text-[0.98em] font-semibold mt-1.5 mb-0.5">{children}</div>,
          h6: ({ children }) => <div className="text-[0.98em] font-semibold mt-1.5 mb-0.5">{children}</div>,
          ul: ({ children }) => <ul className="list-disc pl-4 mb-1.5 space-y-0.5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-4 mb-1.5 space-y-0.5">{children}</ol>,
          li: ({ children }) => <li>{children}</li>,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          del: ({ children }) => <del className="line-through opacity-70">{children}</del>,
          hr: () => <hr className="my-2 border-0 border-t border-zinc-500/25" />,
          blockquote: ({ children }) => (
            <blockquote className="pl-2.5 my-1.5 border-l-2 border-zinc-500/35">{children}</blockquote>
          ),

          // FENCED BLOCKS were the biggest hole here — they printed their own
          // backticks. react-markdown v9 routes inline spans AND fenced bodies
          // through `code`, and dropped the `inline` prop that used to tell them
          // apart. Sniffing `className` for `language-` is the usual workaround
          // and it is WRONG for a fence opened with a bare ``` — no language
          // means no class, so the body would be painted as an inline chip.
          //
          // So the box lives on `pre` and undoes the chip on whatever `code` it
          // contains. Structure decides, which is a fact, rather than a class
          // name, which is a hint.
          pre: ({ children }) => (
            <pre className="overflow-x-auto mb-1.5 p-2 rounded-md bg-zinc-500/10 font-mono text-[0.88em] leading-snug [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[1em]">
              {children}
            </pre>
          ),
          code: ({ children, className }) => (
            <code className={`px-1 py-0.5 rounded bg-zinc-500/20 font-mono text-[0.92em] ${className || ''}`}>
              {children}
            </code>
          ),

          a: ({ children, href }) => {
            const dest = href || ''
            return (
              <a
                href={dest}
                className="underline text-sky-500 hover:text-sky-400"
                onClick={(e) => { e.preventDefault(); openHref(dest) }}
              >
                <Glyph kind={linkKind(dest)} />
                {children}
              </a>
            )
          },

          // NEVER FETCHED. A remote image would be a network request made on
          // behalf of whatever an agent happened to write. Shown as what it is:
          // a link to a picture.
          img: ({ src, alt }) => {
            const dest = typeof src === 'string' ? src : ''
            return (
              <a
                href={dest}
                className="underline text-sky-500 hover:text-sky-400"
                onClick={(e) => { e.preventDefault(); openHref(dest) }}
              >
                <Glyph kind="image" />
                {alt || dest || 'image'}
              </a>
            )
          },

          // The overlay is narrow, so a wide table scrolls rather than forcing
          // the whole panel sideways.
          table: ({ children }) => (
            <div className="overflow-x-auto mb-1.5 -ml-0.5">
              <table className="border-collapse text-[0.9em]">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="text-left font-semibold px-1.5 py-0.5 border-b border-zinc-500/40 whitespace-nowrap">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-1.5 py-0.5 border-b border-zinc-500/20 align-top whitespace-nowrap">
              {children}
            </td>
          ),
        }}
      >
        {text || ''}
      </ReactMarkdown>
    </div>
  )
}
