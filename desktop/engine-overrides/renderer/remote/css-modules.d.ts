// Side-effect CSS imports (e.g. xterm.js's stylesheet) carry no type — vite
// bundles them at build time. Declare them so the renderer typecheck resolves.
declare module '*.css'

// Image assets imported as URLs (e.g. setup screenshots, the logo). Vite
// resolves these to a hashed asset path at build time; for the typecheck they
// resolve to a string module default.
declare module '*.png' { const src: string; export default src }
declare module '*.svg' { const src: string; export default src }
declare module '*.jpg' { const src: string; export default src }
declare module '*.jpeg' { const src: string; export default src }
