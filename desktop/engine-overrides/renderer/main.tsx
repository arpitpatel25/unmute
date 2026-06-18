// Unmute renderer entry — OVERRIDE (full-file, like app/App.tsx).
//
// Adds the Unmute Remote floating overlay route (#/overlay) to the engine's
// hash-based window routing, alongside the existing pill (#/widget). The main
// process opens a dedicated transparent window at this hash (see remote/overlay.ts).

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './app/App'
import WidgetApp from './widget/WidgetApp'
import { OverlayApp } from './remote/OverlayApp'
import './styles.css'

const hash = window.location.hash

function RootApp() {
  if (hash === '#/widget') return <WidgetApp />
  if (hash === '#/overlay') return <OverlayApp />
  return <App />
}

const root = document.getElementById('root')!
createRoot(root).render(
  <StrictMode>
    <RootApp />
  </StrictMode>
)
