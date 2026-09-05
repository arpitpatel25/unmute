# Website and product review

Reviewed September 6, 2026. Competitor claims below describe their public marketing; they are not independently measured benchmarks. Browser screenshots were inspected for both competitors, the production Unmute page, and the new implementation.

## The existing Unmute site

Production is `justunmute.me`, matching CNAME and main at 7fc5682. The previous interactive work is on `feat/exact-interactive-demo` at 358fb5a; the new branch is based on that commit, as requested. Production is a different, newer content revision, so it was inspected separately.

The current page has a strong point of view about existing agents, but asks a first-time visitor to absorb a long argument before understanding the interface. The dark, monospace treatment makes it feel like developer documentation. Dense paragraphs mix product benefits, implementation history, competitive criticism, pricing, and installation troubleshooting. Assertions about universal latency, superiority, and meeting-note quality lack accompanying evidence. The native Notch, which is the clearest product differentiator, is explained primarily in prose. Secondary pages share the same documentation style; legal pages have a different embedded style. Titles and social metadata vary, and there are no crawl files on the base branch.

The older interactive branch has valuable real transcription code: explicit microphone permission, MediaRecorder lifecycle cleanup, quota handling, multipart transport, retryable failures, and 22 passing tests. That logic remains in the repository for future reconnection. The public trial page uses the guided preview because the hosted endpoint currently returns HTTP 401 for unauthenticated GET and POST requests. The new primary preview requires no permissions or network service and never pretends to run actual agent work.

## Competitor comparison

| Dimension | Wispr Flow | VoiceOS | Unmute redesign decision |
|---|---|---|---|
| Initial message | Specific speech-to-writing promise | Broad voice assistant promise | Explain dictation and agent work together |
| Visual identity | Pale yellow, editorial serif, lavender controls | White, oversized sans, glossy controls, blue desktop | Cool neutral palette, native typography, custom slate desktop |
| Demonstration | Speech transformed into polished writing | Familiar app actions in a display/notch scene | Operable task, dictation, capture, notes, memory previews |
| Information sequence | Dictation, personalization, trust, social proof | Cursor context, action examples, privacy, testimonials | Product first, keys, context, agents, notes, privacy, pricing |
| Interaction | Transformation examples and product selector | Prominent action examples and animated app scenes | User-triggered state changes; visible reset and keyboard tabs |
| Differentiation | Writing quality and broad device coverage | Context-aware actions across apps | Existing agent sessions, local mode, attention management |
| Trust | Certifications and named testimonials | Privacy language and named testimonials | Explain data paths; avoid invented endorsements |
| Conversion | Repeated download links | Prominent Mac download | Consistent download links, free local entry, separate product preview |

Wispr also markets vocabulary, snippets, app-specific styles, and 100+ languages. Its current product navigation includes a notetaker, so describing it as exclusively dictation would be outdated. These observations come from [Wispr Flow](https://wisprflow.ai/).

VoiceOS demonstrates cursor context, finding files, messaging, reminders, and app actions. Its public positioning already extends beyond dictation; Unmute must explain its own workflow instead of claiming that voice-to-action alone is unique. These observations come from [VoiceOS](https://www.voiceos.com/).

### Pricing context

[Wispr pricing](https://wisprflow.ai/pricing) lists Pro at $15/user/month or $12/user/month with annual billing. Free quotas vary by platform. Its team and enterprise offering includes controls that this Unmute build does not claim to provide.

[VoiceOS pricing](https://www.voiceos.com/pricing) showed Pro at $11.99/month billed annually, with a seven-day trial requiring a card. The page says new accounts start on that trial; cancellation leaves 100 dictation sessions and 25 agent sessions weekly. It describes Mac and Windows support, with mobile forthcoming. Prices can vary by region. The redesign does not publish a potentially stale competitor price table.

Unmute's local Billing.tsx has Dictation at $4.99/month or $49/year, and Unmute at $7.99/month or $79/year. The production landing page instead advertises $5.99/$59 and $8.99/$89. The redesign uses Billing.tsx because the brief requested product accuracy from unmute-cloud. Actual hosted checkout prices were not changed or verified through a purchase. Resolve this mismatch before publishing.

## Product-to-page traceability

| Product element | Source inspected | Website treatment |
|---|---|---|
| Local/cloud/BYOK modes | unmute-cloud/README.md; renderer/app/help/Dictation.tsx | Separate data paths; local is free, cloud is opt-in |
| Raw dictation and deletion-only cleanup | renderer/app/help/Dictation.tsx | No automatic-authorship promise; formatting is separate |
| Caps Lock instructions | renderer/app/help/Instruct.tsx | Explicit selected-text formatting example |
| Notch shape | native-notch/Sources/unmute-notch/NotchShape.swift | Black mass with concave top shoulders and convex bottom corners |
| Type, status, motion | native-notch/Sources/unmute-notch/Theme.swift | System type; green working, orange needs-you, teal ready; 240ms morph |
| Sessions and computer use | UNMUTE_PROJECT_OVERVIEW.md sections 3 and 5 | Connected agents; ordinary sessions; background supported actions |
| Scratchpad | UNMUTE_PROJECT_OVERVIEW.md; ScratchpadView.swift | Deliberately held capture; words and context before delivery |
| Unmute Agent | UNMUTE_PROJECT_OVERVIEW.md | Right Command, memory, past dictation, meetings, earlier sessions |
| Meeting notes | UNMUTE_PROJECT_OVERVIEW.md | Left Control twice; mic and system audio; connected CLI writes notes |
| Plans | desktop/src/paywall/Billing.tsx lines 47–65 | Three plans and monthly/annual totals |
| Provider artwork | Existing local ui-replica/img, alongside native ProviderMark implementation | Product provider marks; no competitor artwork reused |

The browser preview is a carefully styled translation, not a capture of a running native app. It uses illustrative content and a compact composition for smaller screens. No arbitrary performance, language-count, certification, or endorsement claims are added.

## Existing policy issues to resolve before release

The legal documents retain the existing policy substance. All three documents are dated June 2026; terms/refunds describe prepaid credits rather than the current subscription plans. Privacy and terms name whisper.cpp, whereas current product help names Parakeet v3. They do not comprehensively describe Remote, meetings, or memory. A visual redesign does not establish new commercial or privacy policy, so these gaps are documented rather than silently inventing refund rights or retention promises. The marketing copy explains the current local/cloud distinction and the role of the user's connected agent.

## Design implementation

All nine HTML pages have shared navigation/footer, a single H1, unique title and description, canonical link, OG/Twitter metadata and responsive layouts. The home page adds a clear product sequence, a five-mode demonstration, four-key explanation, scratchpad, connected agents, meeting notes/memory, data-path explanation, plans and FAQ. Dictation and Remote go deeper. The manifesto now carries the longer product philosophy without interrupting the main conversion path. Robots and sitemap make canonical pages discoverable.

The layout uses native Mac typography without remote font requests. Motion follows user actions rather than continuous scroll effects. Reduced-motion settings disable animated transitions. Product tab controls have arrow/Home/End navigation; mobile navigation supports Escape; example state updates are announced without reading the entire simulated desktop.

## Hosted voice-demo availability

Read-only/empty-request checks of the inherited endpoint `https://unmute-pipeline.zodpatel.workers.dev/v1/demo/stt` returned HTTP 401 (missing bearer token). OPTIONS responds but does not allow the client’s session-token header. No visitor audio was recorded or sent. The site therefore exposes guided examples, without requesting microphone access. The existing recorder, transport, state and view modules remain tested but are not mounted by the redesigned site. Restoring an anonymous live service is a backend task, not a visual change, and was not performed.

## Verification

Baseline: 22 inherited unit tests passed before changes. Added model tests and desktop/mobile Playwright coverage. Browser checks exercise routes, metadata, images, overflow, task reply flow, overview, reset, sample formatting, all preview modes, price intervals, FAQs, reduced motion, arrow-key tabs, mobile navigation and draft preservation. The download URL returned HTTP 200. `scripts/check-site.mjs` checks local references and social image existence, including metadata assets absent from normal DOM image checks.

Independent code review identified reset flags, editable sample ambiguity, and keyboard/draft preservation. These were corrected with regression coverage. The sample transcript is read-only; visitors can use the app for their own dictation. A regression exposed a literal template placeholder in draft restoration; it was corrected before final verification.

Screenshots were inspected for home, demo, pricing and the browser preview at desktop and mobile sizes. They are evidence of the reviewed implementation, not an assertion of pixel equality with the native Swift app. No product code or cloud infrastructure was modified.

Final results: 25 unit tests passed; 35 browser tests passed. One desktop invocation of the mobile-only navigation test was intentionally skipped. Nine pages passed local-link/social-asset checks, formatting checks passed, and `git diff --check` reported no whitespace errors.
