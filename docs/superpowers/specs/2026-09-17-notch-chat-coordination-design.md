# Notch Chat Coordination Design

## Goal

Make the native notch chat reliably show its conversation, keep the most recently addressed task first, let both composer and right-Option pill change an existing conversation's model through the same authoritative path, and keep an active pill visually above the notch.

## Conversation history

The controller continues to hydrate provider history lazily and initially sends a bounded ten-message window. The native view chooses rich blocks only when they produce a renderable conversation; otherwise it falls back to the lightweight conversation rows. Loading, missing, partial, and retry states remain visible. Loading older messages must preserve the reader's position and must never replace usable fallback rows with an empty rich projection.

## Task ordering

`lastUserInputAt` is the durable authority for which task the user addressed most recently. The controller's in-memory addressed stamp covers the immediate interval before persistence/reconciliation. Pocket ordering sorts by this combined value before every other criterion. Failure or attention state changes presentation, but does not outrank a more recently addressed task. A user message releases a visit's frozen order so the addressed task becomes first immediately.

## Existing-conversation model switching

Both the composer settings control and an addressed right-Option pill call the existing per-conversation configuration operation. The task manager validates ownership and idle state, asks the provider to accept the new model (and default effort when required), persists the accepted configuration, updates the task receipt, and emits one task update. The notch and pill then redraw from that committed task state. Model controls remain disabled/rejected while a turn is active; switching does not interrupt work.

Externally owned conversations retain their existing limitation: their settings are managed in the source application. Claude Desktop's accessibility-backed model writer remains provider-specific, but its accepted result still updates the same task receipt and both surfaces.

## Window ordering

The notch remains at the screen-saver window level. The pill uses a distinct level one step above it for its full lifetime, whether hidden or visible. Window ordering therefore does not depend on whether the pill or notch was presented most recently.

## Testing

Add focused TypeScript regressions for ordering and addressed pill configuration, pure Swift tests for renderable-history selection and window-level priority, and retain existing pagination/configuration tests. Run the focused suites, the full desktop test suite, Swift package tests, and type checking.
