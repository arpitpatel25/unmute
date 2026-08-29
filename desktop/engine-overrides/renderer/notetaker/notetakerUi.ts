// Notetaker UI feature flags.
//
// TRANSCRIPTS ARE STILL GENERATED AND STILL STORED — this only controls
// whether the user is given a way to LOOK at them. Raw STT text and the
// cleaned transcript both remain on disk exactly as before, the cleanup
// stage still runs, and the notes agent still reads them. Nothing in the
// pipeline branches on this flag; it is purely presentational.
//
// The transcript UI was withdrawn because notes are the product and a raw
// transcript is working material. Every piece of that UI is intact behind
// this switch — the Notes/Transcript tab bar, the segment list, and the
// "Copy transcript" action — so bringing it back is this one line:
//
//     export const SHOW_TRANSCRIPT_UI: boolean = true
//
// (Annotated `boolean` rather than left to infer `false`, so flipping it
// never turns the guarded branches into "unreachable comparison" errors.
// Both states are compiled and verified to be equally clean.)
//
// Deliberately NOT covered by this flag, because neither shows a
// transcript: the meeting recording player, and "Re-transcribe" (which
// re-runs STT and regenerates the notes — the only way to recover notes
// that were poor because the speech-to-text was poor).
export const SHOW_TRANSCRIPT_UI: boolean = false
