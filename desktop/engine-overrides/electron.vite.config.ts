import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

// Paywall env vars injected at build time. Reading from process.env so the
// values can be supplied by CI / the build wrapper without hardcoding them.
// Missing values become empty strings; the renderer crashes loudly on auth
// attempts in that case rather than silently doing nothing.
const SUPABASE_URL = process.env.__SUPABASE_URL__ || ''
const SUPABASE_ANON_KEY = process.env.__SUPABASE_ANON_KEY__ || ''
const PIPELINE_URL = process.env.__PIPELINE_URL__ || ''
// Payments worker URL (Dodo checkout sessions + webhook + return bounce).
// Separate from the pipeline (STT/LLM) so the two can be deployed and
// scaled independently. Defaults to empty; renderer crashes loudly on
// top-up attempt if not set, rather than silently failing.
const PAYMENTS_URL = process.env.__PAYMENTS_URL__ || ''

const paywallDefines = {
  __SUPABASE_URL__: JSON.stringify(SUPABASE_URL),
  __SUPABASE_ANON_KEY__: JSON.stringify(SUPABASE_ANON_KEY),
  __PIPELINE_URL__: JSON.stringify(PIPELINE_URL),
  __PAYMENTS_URL__: JSON.stringify(PAYMENTS_URL),
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: paywallDefines,
    build: {
      outDir: 'dist/electron',
      lib: {
        entry: resolve(__dirname, 'electron/main.ts')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    define: paywallDefines,
    build: {
      outDir: 'dist/preload',
      lib: {
        entry: resolve(__dirname, 'electron/preload.ts')
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'renderer'),
    define: paywallDefines,
    build: {
      outDir: resolve(__dirname, 'dist/renderer'),
      rollupOptions: {
        input: resolve(__dirname, 'renderer/index.html')
      }
    },
    plugins: [tailwindcss()]
  }
})
