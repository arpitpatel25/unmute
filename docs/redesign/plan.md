# Unmute website redesign

Base: feat/exact-interactive-demo at 358fb5a. New branch: feat/landing-redesign.

Design: an architectural redesign of the static site, authorized by the full-site brief. Preserve only the official logo visually. Use cool white #fbfcfe, ink #17191d, secondary #616773, silver #e8ebef and blue #2463eb. System sans typography reflects the native Mac interface. Large confident headings, precise quiet navigation, broad product stages and editorial feature sections. The Notch is the signature object, with concave shoulders, opaque content, status-only color and 240ms transitions derived from native Swift sources. Avoid competitor artwork, invented testimonials and unsupported speed claims.

Implementation:
- [x] Replace landing, dictation, Remote, pricing, manifesto and legal page presentation with shared static chrome and responsive CSS.
- [x] Build deterministic interactive product previews: dictation, formatter, scratchpad, agent task attention/cockpit/reply/terminal, meetings and memory.
- [x] Preserve the tested transcription modules; use the working guided preview on try.html because the hosted public STT endpoint currently returns 401.
- [x] Add consistent titles, descriptions, canonical/OG/Twitter metadata, crawl files and structured product data.
- [x] Validate existing tests and new interaction tests, inspect desktop/mobile screenshots, exercise links and keyboard interactions.

Product sources: ../unmute-cloud/UNMUTE_PROJECT_OVERVIEW.md, desktop/native-notch/Sources/unmute-notch/{Theme,NotchShape,NotchView}.swift, desktop/src/paywall/Billing.tsx and current public site content. Legal terms retained as authoritative text, with redesigned presentation. No app/backend changes. No deployment.
