# Hero design revision

## References reviewed

- [Raycast](https://www.raycast.com/): compact message, strong brand hierarchy, one dominant visual. Its dark art direction is a reference for focus, not a palette to copy.
- [Linear](https://linear.app/homepage): clear sans-serif hierarchy and product UI that supports the promise immediately.
- [Granola](https://www.granola.ai/): split composition places the product beside the headline; typography has distinct roles. Its serif is not appropriate to the requested Unmute treatment.
- [Pangram Pangram pairing guide](https://pangrampangram.com/blogs/journal/the-pangram-pangram-font-pairing-guide): contrast should establish roles rather than decorate every line.

## Chosen direction

Split desktop hero, with copy on the left and a live product frame on the right. White and charcoal, forest green only for the rotating phrase and small markers. No blue or purple page surfaces. The product captures retain the existing grayscale treatment.

[Manrope](https://fonts.google.com/specimen/Manrope) 800 makes **unmute** prominent. [DM Sans](https://fonts.google.com/specimen/DM+Sans) supplies real italics for **Just** and **for …**, plus readable body copy. Fonts are self-hosted variable fonts, downloaded from the official google/fonts repository; their OFL licenses sit beside them.

Rotating examples form complete sentences with the unchanged prefix “Just unmute for”. Examples cover sessions, follow-ups, recall, dictation and meeting notes. They remain synchronized to the real UI demo, about two seconds per example. Pause and next controls remain available. The heading reserves space for the longest phrase so the CTA does not jump.

Philosophy stays in the why section and close. The concrete supporting copy, session terminology, attention section and real screenshots are preserved.

## Verification

JavaScript syntax checks and targeted diff whitespace check. Browser review at desktop, 390px and 320px; all nine phrases checked for wrapping and horizontal overflow. No broad desktop test suite or build: this revision affects static landing-page styling and copy. Nothing pushed or deployed.
