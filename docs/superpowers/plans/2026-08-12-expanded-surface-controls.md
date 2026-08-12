# Expanded Surface Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add temporary 70/80/90 percent expansion controls to every native-notch expanded surface and move the Remote recording chip to the bottom centre of expanded task content.

**Architecture:** A small pure `SurfaceSizeStep` type owns valid fill values and stepping. `AppController` combines the saved default fill with a session-only override, resets the override on collapse, and exposes shrink/enlarge actions through `NotchModel`. SwiftUI surface footers render a common icon-only control pair. Task surfaces render the existing aimed chip as a bottom-centred overlay.

**Tech Stack:** Swift 5.9, SwiftUI, AppKit, XCTest via Swift Package Manager.

## Global Constraints

- Persistent Appearance settings remain exactly 0.7, 0.8, or 0.9.
- Temporary changes apply only while task/cockpit is expanded and reset on collapse.
- Controls are icon-only, with accessible labels/tooltips.
- The Remote-only recording indicator remains hidden for ordinary dictation.

---

### Task 1: Define and test fill stepping

**Files:**
- Create: `desktop/native-notch/Sources/SurfaceSizeSupport/SurfaceSizeStep.swift`
- Create: `desktop/native-notch/Tests/SurfaceSizeSupportTests/SurfaceSizeStepTests.swift`
- Modify: `desktop/native-notch/Package.swift`

**Interfaces:**
- Produces `SurfaceSizeStep.values`, `SurfaceSizeStep.next(after:direction:)`, and `SurfaceSizeStep.Direction`.

- [ ] **Step 1: Write the failing test**

```swift
func testSteppingUsesOnlySupportedFillsAndStopsAtBounds() {
    XCTAssertEqual(SurfaceSizeStep.next(after: 0.8, direction: .smaller), 0.7)
    XCTAssertEqual(SurfaceSizeStep.next(after: 0.8, direction: .larger), 0.9)
    XCTAssertNil(SurfaceSizeStep.next(after: 0.7, direction: .smaller))
    XCTAssertNil(SurfaceSizeStep.next(after: 0.9, direction: .larger))
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `swift test --filter SurfaceSizeStepTests`

Expected: compilation failure because `SurfaceSizeStep` does not exist.

- [ ] **Step 3: Write the minimal implementation**

```swift
enum SurfaceSizeStep {
    enum Direction { case smaller, larger }
    static let values: [CGFloat] = [0.7, 0.8, 0.9]
    static func next(after fill: CGFloat, direction: Direction) -> CGFloat? { /* adjacent value */ }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `swift test --filter SurfaceSizeStepTests`

Expected: PASS.

### Task 2: Apply a transient override in the native controller

**Files:**
- Modify: `desktop/native-notch/Sources/unmute-notch/AppController.swift`
- Modify: `desktop/native-notch/Sources/unmute-notch/NotchModel.swift`

**Interfaces:**
- Consumes `SurfaceSizeStep.next(after:direction:)`.
- Produces `NotchModel.canShrinkSurface`, `NotchModel.canEnlargeSurface`, `NotchModel.shrinkSurface`, and `NotchModel.enlargeSurface` callbacks.

- [ ] **Step 1: Add the controller-owned temporary fill**

```swift
private var temporarySurfaceFill: CGFloat?
private var activeSurfaceFill: CGFloat { temporarySurfaceFill ?? NotchGeometry.SurfaceFill.user }
```

Reset `temporarySurfaceFill` whenever the controller leaves `.task` or `.cockpit`; use `activeSurfaceFill` to derive the scale applied by `resolve`.

- [ ] **Step 2: Add bounded actions and model callbacks**

```swift
func stepSurface(_ direction: SurfaceSizeStep.Direction) {
    guard isExpanded(model.state), let next = SurfaceSizeStep.next(after: activeSurfaceFill, direction: direction) else { return }
    temporarySurfaceFill = next
    refit(animated: true)
}
```

Refresh callback availability whenever the controller applies a state or setting update.

- [ ] **Step 3: Compile the helper**

Run: `swift build -c release`

Expected: successful native executable build.

### Task 3: Render shared controls and relocate the aimed chip

**Files:**
- Create: `desktop/native-notch/Sources/unmute-notch/SurfaceSizeControls.swift`
- Modify: `desktop/native-notch/Sources/unmute-notch/TaskSurfaceView.swift`
- Modify: `desktop/native-notch/Sources/unmute-notch/WallView.swift`
- Modify: `desktop/native-notch/Sources/unmute-notch/StageView.swift`

**Interfaces:**
- Consumes the four `NotchModel` surface-control properties from Task 2.
- Produces reusable `SurfaceSizeControls(model:)`.

- [ ] **Step 1: Add icon-only controls**

```swift
struct SurfaceSizeControls: View {
    @ObservedObject var model: NotchModel
    var body: some View {
        HStack(spacing: 6) { /* disabled shrink and enlarge buttons */ }
    }
}
```

Use SF Symbols for reduce/increase size, `QuietButton` styling or equivalent, and tooltips that identify each action.

- [ ] **Step 2: Place controls on all expanded surfaces**

Insert the control pair immediately before task Prev/Next. Add it to the dashboard’s bottom-right footer and focused cockpit task controls without changing their existing navigation/close behavior.

- [ ] **Step 3: Move the aimed chip into expanded task overlays**

Remove the compact chip from the task and stage headers. Wrap each full task content surface in a `ZStack` and conditionally place `AimedChip(level:compact:)` at `.bottom`, horizontally centred, without changing pocket rendering.

- [ ] **Step 4: Verify build and desktop tests**

Run: `swift test --filter SurfaceSizeStepTests`

Run: `swift build -c release`

Run: `npm test -- --runInBand desktop/electron/remote/notch/notch-controller.test.ts`

Expected: all commands pass.

### Task 4: Final validation and commit

**Files:**
- Modify: files from Tasks 1–3 only.

- [ ] **Step 1: Inspect the final diff**

Run: `git diff --check` and `git diff --stat`.

- [ ] **Step 2: Commit the implementation**

```bash
git add desktop/native-notch
git commit -m "fix(notch): add transient expansion controls"
```
