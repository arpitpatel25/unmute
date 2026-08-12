# Expanded surface controls and recording indicator

## Goal

Let a person temporarily resize any expanded native-notch surface without
changing their saved Appearance setting, and make Remote recording visible in
the correct place while an expanded task is the capture target.

## Surface-size controls

The existing Appearance preference remains the only persistent size setting:
70%, 80%, or 90%.  Opening a task, dashboard, or focused cockpit task begins
at that selected value.

The native notch controller will retain a session-local size selection for the
currently expanded visit.  Icon-only shrink and enlarge buttons move the
selection through 70%, 80%, and 90%, and apply the selected scale to the whole
expanded surface.  The controller resets this temporary selection whenever the
surface leaves the expanded task/cockpit states; neither the Electron setting
nor the next expansion is changed.

Controls live in each surface's own lowest control area.  On task detail they
are immediately left of Prev and Next.  On dashboard and cockpit views they
are bottom-right.  Disabled controls communicate the bounds without numeric
labels; accessibility labels and tooltips name the action.

## Recording indicator

During a Remote capture aimed at an expanded task, the existing `AimedChip`
will be rendered at the bottom centre of the expanded task plane rather than
beside the task title/provider mark.  This applies to the task detail and a
focused cockpit task.  It remains Remote-only and continues to disappear as
soon as capture is no longer recording.  The pocket indicator is out of scope
and remains where it is.

## Verification

Add focused native-notch unit coverage for transient size stepping and reset,
then run the relevant desktop test suite and compile the native notch helper.
