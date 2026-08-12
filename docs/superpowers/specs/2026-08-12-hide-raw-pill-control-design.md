# Hide the RAW Pill Control

**Status:** approved for implementation

## Goal

Temporarily remove the user-facing RAW capsule from every implementation of
the capture pill. Raw-mode behavior remains available internally; this change
does not delete or alter routing, persistence, settings, IPC, or task modes.

## Scope

Unmute has two implementations of the capture pill:

- the native Swift notch pill in `PillView.swift`
- the React/Electron fallback pill in `WidgetApp.tsx`

Both controls and their private view components will be removed. The native
pill may continue receiving `raw` in its state payload, and the Electron API may
continue exposing the session override. Keeping those contracts intact makes
this a presentation-only change that can be reversed without reconstructing
backend behavior.

The Remote Settings raw-mode preference is outside this change. The requested
temporary removal concerns the RAW capsule shown beside the provider/model
control, not the underlying configuration surface.

## Verification

A source-level regression check will assert that neither pill implementation
contains a rendered RAW control while the backend raw-mode types and handlers
remain present. Existing Swift and renderer compilation checks will verify that
removing the private components leaves both implementations valid.

## Screenshot Issue

The separate Right Option image behavior will be diagnosed but not changed in
this implementation. Its finding will be reported after the RAW pill commit.
