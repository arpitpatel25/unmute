// Side-effect CSS imports (e.g. xterm.js's stylesheet) carry no type — vite
// bundles them at build time. Declare them so the renderer typecheck resolves.
declare module '*.css'
