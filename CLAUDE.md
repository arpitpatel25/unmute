# Verification in this repository

Keep verification proportional to the change. For a routine edit, run only the directly relevant test file or a small set of related tests, once after the change. For documentation, copy, styling, and other changes that cannot affect runtime behavior, a test run is usually unnecessary.

Do not run the full desktop test suite (`cd desktop && npm test`), broad test globs, full-project typechecks, or builds by default. Run them when the user explicitly asks, when preparing a release, or when the change affects shared infrastructure or a cross-cutting contract that focused checks cannot cover. If broader verification is needed, explain why and run it once rather than repeatedly.

Do not add tests solely to mirror a trivial implementation detail. When a behavior change needs a regression test, keep it focused on the behavior. In the final report, say which checks ran and which broader checks were skipped. Never claim an unrun suite passed.
