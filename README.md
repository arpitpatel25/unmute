# Unmute website

A static, responsive website for Unmute, with interactive product previews.

## Preview

```sh
npm ci
npm run dev
```

Open http://localhost:4173. Python 3 serves the production-ready static files; there is no build step and no runtime dependency on a frontend framework.

## Checks

```sh
npm test
npm run test:browser
npm run format
```

Browser tests use the installed Google Chrome through Playwright. Start the preview server before running them. Tests cover all nine pages on desktop and mobile, product states, agent replies, reset behavior, keyboard controls, reduced motion, billing intervals, and menu navigation.

## Files

- `index.html`, `dictation.html`, `remote.html`, `pricing.html`, `manifesto.html`, `privacy.html`, `terms.html`, `refund.html`, `try.html`: static pages, including crawlable copy and page-specific metadata.
- `site.css`, `site.js`: shared layout, responsive navigation and billing switch.
- `product-demo.js`, `product-model.js`: guided examples. They never access microphones, execute agent work, or send visitor content to a backend. Replies stay in page memory.
- `assets/`: product provider artwork.
- `robots.txt`, `sitemap.xml`, `og.png`: search and sharing assets.
- `scripts/capture.mjs`, `scripts/social-card.mjs`: reproducible screenshot and social-card rendering, with the local server running.
- `docs/redesign/review.md`: competitor review, source traceability and release caveats.
- `docs/redesign/screenshots/`: reviewed desktop/mobile screenshots.

The inherited `demo*.js` modules and their tests remain available for a future live transcription integration. They are not loaded by the redesigned site: the inherited hosted endpoint returns 401 for unauthenticated requests. `demo.css` and `live-demo.css` retain the matching optional styling.

## Branch and release

Created in a separate worktree at `../unmute-landing-redesign`, on `feat/landing-redesign`, from `feat/exact-interactive-demo` commit `358fb5a`. Production/main was inspected for newer product copy and the official logo. No deployment, merge, or changes to unmute-cloud were made.

Before publishing, resolve the documented app-versus-site pricing mismatch and update the existing June 2026 legal policies for current subscription plans and product features. Legal policy substance was preserved, not invented by this redesign.
