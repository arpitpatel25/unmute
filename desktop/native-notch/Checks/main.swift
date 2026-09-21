import Foundation
import AppKit
import SwiftUI
import SurfaceStateSupport

func check(_ name: String, _ ok: Bool) {
    print("\(ok ? "PASS" : "FAIL")  \(name)")
    if !ok { exit(1) }
}

func near(_ a: CGFloat, _ b: CGFloat, _ tol: CGFloat = 0.5) -> Bool { abs(a - b) <= tol }

// The EXACT line scratchpadPayload() in init.ts produces, with a focused task.
let full = #"""
{"type":"scratchpad","data":{"enabled":true,"armed":true,"delivering":false,"pad":{"id":"p1","origin":"task","entries":[{"id":"s1","type":"segment","text":"add the retry to the uploader","startMs":1000,"endMs":8400},{"id":"i1","type":"insert","kind":"image","content":"/Users/x/Desktop/Screenshots/Shot 1.png","atMs":5000},{"id":"i2","type":"insert","kind":"url","content":"https://example.com/a","atMs":6000}]},"destinations":{"cursor":true,"newTask":true,"openTask":{"id":"t9","name":"uploader work"}}}}
"""#
guard case let .scratchpad(p) = Command.decode(full) else { check("full payload decodes", false); exit(1) }
check("full payload decodes", true)
check("armed", p.armed == true)
check("delivering", p.delivering == false)
check("3 entries", p.pad?.entries.count == 3)
check("segment duration label", p.pad?.entries[0].durationLabel == "0:07")
check("image preview is the file name", p.pad?.entries[1].preview == "Shot 1.png")
check("url glyph", p.pad?.entries[2].glyph == "link")
check("openTask decoded", p.destinations.openTask?.name == "uploader work")
let ord = p.destinations.ordered(origin: p.pad?.origin ?? "cursor")
check("3 destinations, task primary", ord.count == 3 && ord[0].id == "openTask" && ord[0].isPrimary)
check("cursor is an alternative", ord[2].id == "cursor" && !ord[2].isPrimary)
check("hasContent", p.hasContent)

// NO openTask, cursor origin — what a plain dictation pad looks like.
let noTask = #"{"type":"scratchpad","data":{"enabled":true,"armed":false,"delivering":true,"pad":{"id":"p2","origin":"cursor","entries":[{"id":"s1","type":"segment","text":"","startMs":10,"endMs":0}]},"destinations":{"cursor":true,"newTask":true,"openTask":null}}}"#
guard case let .scratchpad(q) = Command.decode(noTask) else { check("no-task payload decodes", false); exit(1) }
check("no-task payload decodes", true)
check("delivering true", q.delivering)
check("open segment has no duration", q.pad?.entries[0].durationLabel == nil)
check("open segment says so", q.pad?.entries[0].preview == "Still transcribing…")
let ord2 = q.destinations.ordered(origin: "cursor")
check("2 destinations without a focused task", ord2.count == 2 && ord2[0].id == "newTask" && ord2[1].id == "cursor")
check("cursor primary for a cursor pad", ord2[1].isPrimary)

// THE ONE THAT MATTERS: keys missing. CockpitData would throw keyNotFound and
// kill the update; every field here defaults instead.
guard case let .scratchpad(m) = Command.decode(#"{"type":"scratchpad","data":{}}"#) else { check("empty data decodes", false); exit(1) }
check("empty data decodes (no keyNotFound)", true)
check("enabled defaults FALSE — no control without a backend", !m.enabled)
check("armed defaults false", !m.armed)
check("delivering defaults false", !m.delivering)
check("pad defaults nil → no panel", m.pad == nil && !m.hasContent)

guard case let .scratchpad(n) = Command.decode(#"{"type":"scratchpad","data":{"pad":{"entries":[{"id":"only-an-id"}]}}}"#) else { check("partial entry decodes", false); exit(1) }
check("partial entry decodes", n.pad?.entries.count == 1)
check("entry type defaults to insert", n.pad?.entries[0].isSegment == false)

// AN ID-LESS ENTRY IS NOT DRAWN. Its × could not remove it (the controller
// drops `scratchpadRemove id:""`) and two of them would collide as ForEach
// identities — a row that cannot be removed is worse than one that is not there.
let idless = #"{"type":"scratchpad","data":{"pad":{"id":"p","entries":[{"id":"keep","type":"insert","content":"a"},{"type":"insert","content":"b"},{"id":"","type":"insert","content":"c"}]}}}"#
guard case let .scratchpad(x) = Command.decode(idless) else { check("id-less payload decodes", false); exit(1) }
check("id-less entries are filtered out", x.pad?.entries.count == 1)
check("the one with an id survives", x.pad?.entries.first?.id == "keep")

// An entirely absent `data` must not become .unknown-and-dropped either.
guard case .scratchpad = Command.decode(#"{"type":"scratchpad"}"#) else { check("missing data → empty payload", false); exit(1) }
check("missing data → empty payload", true)

// Events out.
check("arm event", (Event.scratchpadArm(true).json["type"] as? String) == "scratchpadArm"
      && (Event.scratchpadArm(true).json["on"] as? Bool) == true)
check("remove event", (Event.scratchpadRemove(id: "e1").json["id"] as? String) == "e1")
check("deliver event", (Event.scratchpadDeliver(dest: "openTask").json["dest"] as? String) == "openTask")
check("discard event", (Event.scratchpadDiscard.json["type"] as? String) == "scratchpadDiscard")
check("Agent provider switch event", (Event.agentSwitchProvider(provider: "claude").json["type"] as? String) == "agentSwitchProvider"
      && (Event.agentSwitchProvider(provider: "claude").json["provider"] as? String) == "claude")

// The unarmed fast path: a `pill` line must still decode exactly as before.
guard case let .pill(ps) = Command.decode(#"{"type":"pill","state":{"phase":"recording","elapsed":3}}"#) else { check("pill still decodes", false); exit(1) }
check("pill still decodes", ps.phase == .recording && ps.elapsed == 3)

// THE PAUSED PILL. Main pushes this instead of hiding when an armed stop leaves
// work on the pad; the rawValue must match the string hideNativePill() sends, or
// the phase silently falls back to .hidden and the pill disappears exactly as it
// used to.
guard case let .pill(paused) = Command.decode(#"{"type":"pill","state":{"phase":"paused","model":"Sonnet 4.5"}}"#) else { check("paused pill decodes", false); exit(1) }
check("paused pill decodes", paused.phase == .paused)
check("paused pill keeps the chips it was pushed with", paused.model == "Sonnet 4.5")

// AN UNKNOWN PHASE MUST NOT KILL THE LINE — an older helper against a newer
// engine falls back to hidden rather than dropping the command whole.
guard case let .pill(future) = Command.decode(#"{"type":"pill","state":{"phase":"teleporting","elapsed":9}}"#) else { check("unknown phase still decodes", false); exit(1) }
check("unknown phase still decodes", future.phase == .hidden && future.elapsed == 9)

// AUTO-PRESENT. Additive command; ABSENT MEANS ON, because the setting's
// default is on and a mistyped line must never silently stop the surface
// presenting itself.
guard case let .autoPresent(a1) = Command.decode(#"{"type":"autoPresent","on":false}"#) else { check("autoPresent decodes", false); exit(1) }
check("autoPresent decodes", a1 == false)
guard case let .autoPresent(a2) = Command.decode(#"{"type":"autoPresent"}"#) else { check("autoPresent without `on` decodes", false); exit(1) }
check("absent `on` defaults to ON", a2 == true)
guard case let .autoPresent(a3) = Command.decode(#"{"type":"autoPresent","on":"maybe"}"#) else { check("malformed autoPresent decodes", false); exit(1) }
check("malformed `on` defaults to ON", a3 == true)

// ── THE COMPOSER'S COMMAND MENU ON THE WIRE ─────────────────────────────────
//
// `commands` is additive: a host that predates it, or a provider with nothing
// to offer, sends a TaskDetail without the key and the card must still update.
// And every field of a command is defaulted, because ONE undefaulted key in a
// synthesized decoder makes that key mandatory — which does not drop the
// command, it drops the entire TaskDetail, and the card silently stops moving.
let withCommands = #"""
{"type":"showTask","task":{"id":"t1","title":"Build","status":"processing","kind":"session","alive":true,"commands":[{"name":"frontend-design","title":"Frontend Design","description":"Guidance for distinctive visual design","argumentHint":"[target]","scope":"Personal","token":"/frontend-design"},{"name":"plan","token":"$plan","scope":"Project"},{"name":"review"}]}}
"""#
guard case let .showTask(t1) = Command.decode(withCommands) else { check("task with commands decodes", false); exit(1) }
check("task with commands decodes", t1.commands?.count == 3)
check("the token is carried verbatim", t1.commands?[0].token == "/frontend-design")
check("a provider-native token is NOT rewritten to a slash", t1.commands?[1].token == "$plan")
check("scope and argument hint survive", t1.commands?[0].scope == "Personal" && t1.commands?[0].argumentHint == "[target]")
check("a command with only a name still decodes", t1.commands?[2].name == "review")
check("...with empty strings rather than a dropped task", t1.commands?[2].token == "" && t1.commands?[2].description == "")

let noCommands = #"{"type":"showTask","task":{"id":"t1","title":"Build","status":"processing","kind":"session","alive":true}}"#
guard case let .showTask(t2) = Command.decode(noCommands) else { check("task WITHOUT commands decodes", false); exit(1) }
check("task WITHOUT commands decodes", t2.id == "t1")
check("absent commands is nil — no menu, not a dropped task", t2.commands == nil)

// ── GEOMETRY ─────────────────────────────────────────────────────────────────
//
// The layout maths, with the screen measurements handed in rather than read
// from NSScreen — the numbers below are what `current()` would have measured on
// a 14" MacBook Pro. This is the part that decides whether the surface sits in
// the menu bar row and whether the mass lands on the hole.

let screen = NSRect(x: 0, y: 0, width: 1512, height: 982)
let barH: CGFloat = 37
let cut = NSRect(x: 656, y: 982 - barH, width: 200, height: barH)
let notched = NotchGeometry(screenFrame: screen, hasNotch: true, cutout: cut,
                            barHeight: barH, leftUsable: 656, rightUsable: 656)

check("bar fillet is derived from the measured bar", notched.barFillet == round(barH * NotchGeometry.filletOfBar))
check("outer radius is derived from the measured bar", notched.barCornerRadius == round(barH * NotchGeometry.cornerOfBar))

let m1 = notched.mass(left: 120, right: 300)
check("the middle IS the cutout", m1.middle == cut.width)
check("mass width = fillet + left + cutout + right + fillet",
      m1.width == notched.barFillet * 2 + 120 + cut.width + 300)

let f1 = notched.barFrame(m1)
check("unexpanded height IS the measured menu bar", f1.height == barH)
check("top edge is the SCREEN's top edge, not below the bar", f1.maxY == screen.maxY)
check("the mass's middle lands exactly on the cutout",
      near(f1.minX + m1.fillet + m1.left, cut.minX) && near(f1.minX + m1.fillet + m1.left + m1.middle, cut.maxX))

// Overflow: the right half truncates to the room beside the cutout, and is
// DROPPED rather than ellipsised when what is left cannot say anything.
let tight = NotchGeometry(screenFrame: screen, hasNotch: true, cutout: cut,
                          barHeight: barH, leftUsable: 656, rightUsable: 60)
check("right half is dropped when there is no useful room", tight.mass(left: 120, right: 300).right == 0)
let squeeze = NotchGeometry(screenFrame: screen, hasNotch: true, cutout: cut,
                            barHeight: barH, leftUsable: 656, rightUsable: 200)
let m2 = squeeze.mass(left: 120, right: 300)
check("right half truncates to the usable area",
      m2.right == 200 - squeeze.barFillet - NotchGeometry.barEdgeKeepOut)
check("left half is NEVER truncated", squeeze.mass(left: 900, right: 0).left == 900)

// A display with no cutout: same mass, centred, no reserved middle.
let plain = NotchGeometry(screenFrame: screen, hasNotch: false, cutout: nil,
                          barHeight: 24, leftUsable: 756, rightUsable: 756)
let m3 = plain.mass(left: 120, right: 200)
check("no cutout ⇒ the halves are separated by the air a housing would occupy",
      m3.middle == NotchGeometry.segmentGap && NotchGeometry.segmentGap == 26)
check("one half only ⇒ no gap at all", plain.mass(left: 120, right: 0).middle == 0)
let f3 = plain.barFrame(m3)
check("with no cutout the mass centres on the screen", near(f3.midX, screen.midX, 1))
check("and still sits in the menu bar row", f3.height == 24 && f3.maxY == screen.maxY)

// DORMANT IS A NOTCHED-DISPLAY LUXURY.
//
// On a display WITH a cutout, dormant reserves exactly the cutout (inset, so no
// black spills past its rounded corners) and draws nothing: the hardware is the
// landmark, and "put the pointer in the notch" is a gesture people already have.
//
// On a display WITHOUT one there is nothing to aim at, so AppController never
// enters dormant there — it maps to idle (see applyState). dormantFrame()'s
// no-cutout branch is therefore unreachable in the app. It stays as a 2pt strip
// only so this pure function is total; the check below pins that it is NOT what
// the user ever sees, which is the mistake this replaced: a 2pt hit target at
// dead centre, findable only by accident.
check("dormant off-notch is a degenerate frame, never a real surface", plain.dormantFrame().width == 2)
check("the real off-notch resting frame is idle-sized, and a findable target",
      plain.barFrame(plain.mass(left: 60, right: 0)).width >= 60)
let dz = notched.dormantFrame()
check("dormant hides inside the cutout", dz.width == cut.width - 2 && dz.minX == cut.minX + 1)
check("dormant is still bar height", dz.height == barH && dz.maxY == screen.maxY)

// ── THE SHAPE ────────────────────────────────────────────────────────────────
//
// ONE PATH: the fillets are geometry, not an overlay, and only the OUTER bottom
// corners carry a radius — the stretch that crosses the cutout is straight.

let rect = CGRect(x: 0, y: 0, width: 400, height: 37)
let sh = NotchShape(bottomRadius: 11, topFillet: 11).path(in: rect)
// The flare: along the top edge the black reaches OUT past the mass's wall…
check("the flare is part of the path", sh.contains(CGPoint(x: 6, y: 0.5)))
// …and the region under it is bitten away, which is what makes it concave.
check("the fillet is CONCAVE — bitten out below the flare", !sh.contains(CGPoint(x: 5, y: 5.5)))
check("a fillet-less shape has no bite at all",
      NotchShape(bottomRadius: 11, topFillet: 0).path(in: rect).contains(CGPoint(x: 5, y: 5.5)))
check("the mass's wall is where the fillet ends",
      sh.contains(CGPoint(x: 10.6, y: 5.5)) && sh.contains(CGPoint(x: 12, y: 11)))
check("both ends are treated alike",
      sh.contains(CGPoint(x: 394, y: 0.5)) && !sh.contains(CGPoint(x: 395, y: 5.5)))
check("the bottom edge is straight where it crosses the cutout",
      sh.contains(CGPoint(x: 200, y: 36.5)))
check("the OUTER bottom corners are rounded",
      !sh.contains(CGPoint(x: 11.5, y: 36.5)) && !sh.contains(CGPoint(x: 388.5, y: 36.5)))
// A mass narrower than its own corners is the last frame of a collapse; it must
// degenerate rather than fold inside out.
check("a degenerate mass still produces a path",
      !NotchShape(bottomRadius: 40, topFillet: 40).path(in: CGRect(x: 0, y: 0, width: 6, height: 6)).isEmpty)

// ── MOTION ───────────────────────────────────────────────────────────────────

// THE SPRING IS GONE, AND THESE CHECKS FOLLOWED IT.
//
// This asserted Theme.springResponse / springDamping / springSolver — an
// under-damped spring that overshoots and settles. The surface moved to a
// single eased duration instead (Theme.morph over surfaceTransitionDuration),
// deliberately: an ease reads as one surface and survives a new destination
// arriving mid-transition, which a spring mid-overshoot does not. Nothing named
// `spring` exists in Sources any more.
//
// The INTENT of the original checks survives and is what is asserted now:
// there is exactly ONE timing for the surface, and everything else is defined
// in terms of it rather than carrying its own number.
check("one surface timing, and it is the one the window frame uses",
      Theme.surfaceTransitionDuration == 0.24)
check("reduce-motion's stand-in is shorter than the move it replaces",
      Theme.reducedFadeDuration < Theme.surfaceTransitionDuration)
check("control feedback is faster than the surface it sits on",
      Theme.hoverDuration < Theme.surfaceTransitionDuration)
check("content leaves before the shape and arrives after it",
      Theme.contentOutDuration < Theme.contentInDuration && Theme.contentInDelay > 0)

// ── WHAT THE BAR SAYS ────────────────────────────────────────────────────────

let vm = NotchModel()
// NOTHING RUNNING, NOTHING WAITING — the resting rungs, on their own terms.
//
// These used to run with `working = 2` set, which is a combination the engine
// cannot produce: reconcile commands `active` the moment anything is
// processing, so a dormant or idle rung is the host stating that nothing is.
// The checks below are about what the surface says when it has nothing to say,
// and a phantom count made that question unanswerable.
vm.working = 0
check("dormant says nothing at all", BarContent.make(for: vm, state: .dormant, hovering: false).isEmpty)
// IDLE SAYS DIFFERENT THINGS ON THE TWO DISPLAY KINDS, on purpose.
//
// With a cutout the mass is continuous with the hardware, so the wordmark reads
// as the notch saying something. Without one it would be a black tab with a
// name in it sitting on the desktop — announcing the app on the screens that
// least need it. Off-notch at rest it is a nub instead: no text, short, and
// still a target.
vm.hasNotch = true
let idle = BarContent.make(for: vm, state: .idle, hovering: false)
check("idle ON a notch is ONE segment — the wordmark", idle.left == "unmute" && idle.right == nil && idle.dot == nil)
// IDLE SAYS THE WORDMARK AND NOTHING ELSE, HOVERED OR NOT.
//
// This asserted `right == "2 running"`. That text is gone on purpose:
// BarContent's own comment records why. The controller sends `active` the
// moment anything is running, so idle's count was always zero, and hovering
// "revealed" the words "Nothing running" — a surface volunteering an absence.
// The count moved to the badge on `active`, where one vocabulary covers it.
//
// So the check now pins the DELIBERATE silence, which is the thing that would
// be lost if someone re-added hover text here without reading that comment.
let idleHovered = BarContent.make(for: vm, state: .idle, hovering: true)
check("hover adds nothing to idle — the mark alone is the state",
      idleHovered.left == "unmute" && idleHovered.right == nil && idleHovered.dot == nil)
check("idle never glows", idle.alarm == nil)

vm.hasNotch = false
let resting = BarContent.make(for: vm, state: .idle, hovering: false)
check("idle OFF-notch says nothing", resting.left == nil && resting.right == nil && resting.dot == nil)
check("...and is marked resting", resting.resting)
check("...but still reserves a width, or there is nothing to click",
      resting.leftWidth == BarContent.restingWidth)
check("hovering the nub brings the wordmark back",
      BarContent.make(for: vm, state: .idle, hovering: true).left == "unmute")
vm.hasNotch = true

// ROUTING: the gap between the pill vanishing and the task existing. It has to
// say something, on either display kind, and it outranks the resting states.
vm.capturePhase = "routing"
let routing = BarContent.make(for: vm, state: .idle, hovering: false)
// "Sending", not "creating task". The word changed when the bar settled on one
// vocabulary — status words the whole surface shares — and this assertion was
// never updated because the harness had stopped compiling.
// ROUTING IS A THING IN FLIGHT, SO IT SPEAKS FROM THE RIGHT — the same
// shoulder the task will appear on a moment later, so the bar does not shuffle
// sideways as the words land. It was on the left back when the left was the
// only shoulder that ever carried a status.
check("routing speaks even when idle would rest", routing.right == "Sending")
check("routing shows a working dot", routing.rightDot == .processing)
check("...and the left is the mark, because routing is not asking anything",
      routing.emphasis == .wordmark)
check("routing outranks dormant too",
      BarContent.make(for: vm, state: .dormant, hovering: false).right == "Sending")
check("routing never glows", routing.alarm == nil)
vm.capturePhase = nil
check("and clears cleanly", BarContent.make(for: vm, state: .dormant, hovering: false).isEmpty)
// ── TWO SHOULDERS: WHAT WANTS YOU, AND WHAT IS RUNNING ───────────────────────
//
// docs/superpowers/specs/steps/hover-cases.html. ONE FACT PER SHOULDER: the
// left is the most urgent thing that wants you (the mark when nothing does),
// the right is what is running. Colour is the status, the word names it, the
// number counts it.
//
// The bar could previously say only ONE of those two facts. The waiting branch
// returned above the state switch, so a pocket holding one question hid three
// running tasks completely — the case the spec opens with.

func slot(_ id: String, _ status: String, demanding: Bool, kind: String? = nil) -> PocketSlotP {
    PocketSlotP(id: id, title: id, kind: kind, ask: nil, status: status,
                demanding: demanding, backend: "claude", terminal: false)
}
func pocketOf(_ slots: [PocketSlotP]) -> PocketP {
    PocketP(mode: "closed", at: 0,
            waiting: slots.filter { ($0.demanding ?? false) && $0.kind != "agent" }.count,
            remoteKey: "fn", slots: slots)
}

check("nothing wants you, so there is no rung to name",
      BarShoulders.wanting([]) == nil)
check("one blocked task names itself and counts itself",
      BarShoulders.wanting([slot("a", "needs-user", demanding: true)])
          == BarShoulders.Rung(status: .needsUser, count: 1))

// THE LADDER: Errored / Stuck › Needs you › Ready. Everything below the top
// rung folds into the pocket rather than competing for the one shoulder.
check("red outranks amber",
      BarShoulders.wanting([slot("a", "needs-user", demanding: true),
                            slot("b", "failed", demanding: true)])?.status == .failed)
check("amber outranks teal",
      BarShoulders.wanting([slot("a", "done", demanding: true),
                            slot("b", "needs-user", demanding: true)])?.status == .needsUser)
check("stuck and failed share red, and the failure is the more final of the two",
      BarShoulders.wanting([slot("a", "stuck", demanding: true),
                            slot("b", "failed", demanding: true)])?.status == .failed)

// THE NUMBER COUNTS WHAT THE WORD NAMES. Counting every waiting task under the
// top rung's word would write "Errored 3" on a bar holding one failure.
check("the count counts what the word names, not the whole queue",
      BarShoulders.wanting([slot("a", "failed", demanding: true),
                            slot("b", "needs-user", demanding: true),
                            slot("c", "needs-user", demanding: true)])
          == BarShoulders.Rung(status: .failed, count: 1))
check("a finished-but-unseen task is Ready, not Done",
      BarShoulders.wanting([slot("a", "done", demanding: true)])?.status == .ready)

// The same two exclusions the badge already makes: the Agent is always in the
// pocket, and a card you have already dealt with is not waiting on you.
check("the agent is never counted at you",
      BarShoulders.wanting([slot("a", "needs-user", demanding: true, kind: "agent")]) == nil)
check("a slot that is not demanding is not counted",
      BarShoulders.wanting([slot("a", "needs-user", demanding: false)]) == nil)

check("nothing running, nothing to say on the right", BarShoulders.running(0) == nil)
check("what is running is always the right shoulder",
      BarShoulders.running(3) == BarShoulders.Rung(status: .processing, count: 3))

// ── THE SAME LADDER, AS THE BAR SAYS IT ──

// The spec's worked example: 1 needs you, 3 working.
vm.pocket = pocketOf([slot("a", "needs-user", demanding: true)])
vm.working = 3
let both = BarContent.make(for: vm, state: .attention, hovering: false)
check("the left names what wants you",
      both.dot == .needsUser && both.left == "Needs you" && both.badge == 1)
check("...and the right says what is running, at the same time",
      both.rightDot == .processing && both.right == "Working" && both.rightBadge == 3)
check("only the thing that wants you glows", both.alarm == .needsUser)
// EACH SHOULDER IS SIZED TO WHAT IS IN IT, and this replaced the spec's
// `SH = max(both)`.
//
// Symmetry was there to stop the widths running away, and with task titles off
// the bar they cannot. What it cost was visible the moment the two sides were
// unequal: the mark needs ~50pt and a status needs ~98, so the mark was handed
// a 98pt shoulder and ~37pt of dead black sat between it and the housing while
// the other side was packed tight against it. Reported from the field twice —
// "the notch is not symmetrical, the right side there is a lot of gap".
//
// Nothing is lost by dropping it: barFrame anchors the mass on the MIDDLE, so
// unequal shoulders still hang the surface dead centre on the housing.
// BOTH SHOULDERS ARE ONE WIDTH — the spec's SH = max(left, right), restored.
//
// It was dropped because the mark sat stranded in a shoulder sized for three
// words. That was the right complaint about the wrong cause: the fix is to
// CENTRE the mark in the shoulder it was given, not to shrink the shoulder.
// Shrinking it traded a gap for a visibly lopsided surface, which is worse —
// the two halves of a thing that straddles a piece of hardware have to match.
check("both shoulders are ONE width, sized to the wider of the two",
      both.shoulders.left == both.shoulders.right
          && both.shoulders.left == max(both.leftWidth, both.rightWidth))

// THE RIGHT SHOULDER FILLS FIRST, and this is the case that says so.
//
// One fact goes on the RIGHT with the mark keeping the left. The left only
// takes a status when the right is already holding running work — two facts,
// two shoulders. Shipped the other way round first: a lone "Ready" sat on the
// left against an empty right half, so the status word appeared to change sides
// depending on whether anything happened to be running. See the spec's own
// case table: 'Needs you only' and 'Ready' both draw mark-left, status-right.
vm.pocket = pocketOf([slot("a", "done", demanding: true),
                      slot("b", "done", demanding: true)])
vm.working = 0
let lone = BarContent.make(for: vm, state: .attention, hovering: false)
check("a lone status sits on the right, and the mark keeps the left",
      lone.emphasis == .wordmark && lone.rightDot == .ready
          && lone.right == "Ready" && lone.rightBadge == 2)
check("...so the left carries no status at all", lone.dot == nil && lone.badge == nil)
check("...and it still glows, because it is still the thing that wants you",
      lone.alarm == .ready)
vm.working = 3

// "Nothing wants you" — the left falls back to the mark.
vm.pocket = .empty
let running = BarContent.make(for: vm, state: .active, hovering: false)
check("with nothing waiting the left falls back to the mark",
      running.emphasis == .wordmark && running.dot == nil && running.badge == nil)
check("...and the right still says what is running",
      running.rightDot == .processing && running.right == "Working" && running.rightBadge == 3)
check("a bar with only good news never glows", running.alarm == nil)

// THE TWO OUTER EDGES HOLD THE SAME SPACE.
//
// The mark had a wider lead-in than the ordinary inset, on the reasoning that a
// wordmark looks pinned where a small round dot reads as inset already. True in
// isolation, and wrong across the whole bar: it put 21pt before the mark and
// 13pt after the badge, so the surface sat lopsided inside its own silhouette.
// One number, both ends — the concave flare eats the same space at each.
let markOuter = running.leftWidth - BarContent.gap
    - UnMark.width(for: BarContent.markHeight)
let statusOuter = running.rightWidth - BarContent.gap
    - (BarContent.dotSize + BarContent.gap
       + BarContent.measure("Working", BarContent.statusFont)
       + BarContent.gap + BarContent.badgeWidth(3))
check("the outer edge holds the same space on both shoulders",
      near(markOuter, statusOuter, 1.01) && markOuter > 0)
check("...and it is the edge inset that sets it",
      near(markOuter, BarContent.edgeInset, 1.01))

// THE MARK IS NOT LEFT STRANDED IN A SHOULDER BUILT FOR THREE WORDS.
//
// Both shoulders are set to the wider of the two, so "unmute | Working 3" hands
// the mark a shoulder sized for the status and pins it to the outer edge with
// ~48pt of dead black between it and the housing. Reported from the field as
// the mark "looking orphaned, nothing on its right". The slack is real and the
// symmetry is deliberate — so it is spent on BOTH sides instead of all on one.
// The centring guard survives as exactly that — a guard. With each shoulder
// sized to its content it never fires, and it is what stops a mark drifting to
// the outer edge if anything ever hands it a shoulder bigger than it needs.
// The mark's shoulder is as wide as the status's, and the mark is centred in
// it — which is what stops the surplus all landing on one side of the mark.
let markSh = running.shoulders
check("the mark gets the same shoulder as the status opposite it",
      markSh.left == markSh.right && markSh.left > running.leftWidth)
check("...and is centred in it rather than pinned to the outer edge",
      running.centresMark(inShoulderOf: markSh.left))
check("...and one that exactly fills it is not moved",
      !running.centresMark(inShoulderOf: running.leftWidth))
check("a status shoulder is never centred — it is a list, and lists start",
      !both.centresMark(inShoulderOf: both.leftWidth + 40))

// NO TASK NAMES ANYWHERE. The whole reason the shoulders can be sized to a
// fixed pair of words is that the vocabulary is bounded — six status words and
// a count. One task title on the bar and the arithmetic runs away again.
vm.pocket = pocketOf([slot("a", "needs-user", demanding: true)])
let hovered = BarContent.make(for: vm, state: .attention, hovering: true)
check("hovering reveals no task name — there is nothing longer to reveal",
      hovered.right == "Working" && hovered.left == "Needs you")

// Idle: the mark, and nothing at all on the right.
vm.pocket = .empty
vm.working = 0
let quiet = BarContent.make(for: vm, state: .idle, hovering: false)
check("idle is the mark alone — nothing waiting, nothing running",
      quiet.emphasis == .wordmark && quiet.right == nil && quiet.rightDot == nil)

// ONE AGENT HAS NO COUNT. "and N more like this" is a lie about a single thing.
vm.agentActivity = AgentActivityP(state: .thinking, summary: "reading the spec",
                                  interactionId: nil, agentRunId: nil, provider: nil)
let agent = BarContent.make(for: vm, state: .idle, hovering: false)
check("the agent is what is running, so it speaks from the right",
      agent.rightDot == .processing && agent.right == "Thinking" && agent.rightBadge == nil)
check("...and the left is the mark, because the agent is not asking anything",
      agent.emphasis == .wordmark)
// An agent that is CONFIRMING has stopped running and started asking, so it
// changes shoulders. The ladder does not care what kind of thing is asking.
vm.agentActivity = AgentActivityP(state: .confirming, summary: "delete the branch?",
                                  interactionId: nil, agentRunId: nil, provider: nil)
let asking = BarContent.make(for: vm, state: .idle, hovering: false)
// With nothing running it is still a LONE fact, so it stays on the right — but
// it is now the thing that wants you, so it wears the your-move colour and it
// glows. The shoulder did not change; the news did.
check("an agent that is asking is still one fact, so it stays on the right",
      asking.rightDot == .needsUser && asking.right == "Confirming"
          && asking.emphasis == .wordmark && asking.alarm == .needsUser)
vm.agentActivity = nil

// ── THE ONE SENTENCE LEFT ON THE BAR ──
//
// A toast is feedback for something the user just did AT this surface, so the
// reason has to stay where the action was — it is the one piece of free text
// the bar still carries, and the spec's vocabulary has no word for "why".
//
// It is therefore a SENTENCE, not a shoulder, and the difference is load-
// bearing: shoulders are symmetric, so mirroring an error sentence into the
// left half would have doubled it. Measured in the field on the old build:
// `mass=[401|185|401]`, a 1007pt bar. A sentence keeps the old policy instead —
// it truncates, and it is dropped when it cannot say anything useful.
vm.toast = "Background runtime connection lost; reconnect before sending again."
let toast = BarContent.make(for: vm, state: .idle, hovering: false)
check("a toast still says what went wrong, and why",
      toast.left == "Couldn't complete" && toast.detail == vm.toast)
check("...but a sentence is not a shoulder, so it claims no shoulder of its own",
      toast.shoulders.right == 0 && toast.rightWidth == 0)
check("...and it is the detail half that carries it, not the status half",
      toast.right == nil && toast.detailWidth > toast.leftWidth)
vm.toast = nil

vm.working = 2

// ── THE HOVER RIM: A LINE ON THE SHOULDERS, AND IT STOPS AT THE HOUSING ──
//
// On a black menu bar the mass is black on black and has NO visible edge at
// rest — the only cue today is the cursor changing once you are already inside
// it. A rim gives it one. It may not be a rim around the MASS, though:
// NotchView's D5 forbids a stroke that would outline the black against the
// hardware and put the join back. So the line is drawn on the two shoulders
// and stops dead where the housing begins.

func subpaths(_ p: Path) -> Int {
    var n = 0
    p.forEach { e in if case .move = e { n += 1 } }
    return n
}
let rimMass = notched.mass(left: 98, right: 98, rimDrop: NotchGeometry.rimDrop)
let rim0 = BarRim(placement: notched.mass(left: 0, right: 0, rimDrop: NotchGeometry.rimDrop))

// THE MASS AND THE HOUSING SHARE A BOTTOM EDGE — the geometry says so outright:
// barHeight IS the safe-area inset, which is the height of the housing. So a
// line drawn at the mass's own floor would trace the bottom of the hardware,
// which is the thing D5 forbids. The window therefore extends a little BELOW
// the menu bar, and the line uses that room to pass underneath.
// THE WINDOW IS THE MASS, AND NOTHING HANGS BELOW THE MENU BAR.
//
// The line used to run 3pt lower so it could pass UNDER the housing. It cleared
// the hardware, but against a visible menu bar those 3pt hung down into the
// desktop and the whole surface read as sitting too low — reported from the
// field as "fullscreen is perfect, windowed shifts a little downwards", which
// is exactly the asymmetry you would expect: fullscreen hides the menu bar, so
// there is nothing left to be out of line with.
//
// The drop was never needed. The mass and the housing SHARE a bottom edge
// (barHeight is the safe-area inset), so a line on that edge underlines both at
// once and introduces no seam between them — there is no boundary there to
// outline, which is the whole reason the shape is drawn straight through.
// THE LINE HAS TO SIT BELOW THE MENU BAR TO BE SEEN AT ALL.
//
// The camera housing is hardware: the pixels behind it are not displayed, which
// is the very fact that lets the shape be drawn straight through the cutout. So
// a line on the mass's own floor is still INSIDE the housing across the middle
// third and simply vanishes there — a straight line that is actually visible
// end to end has no choice but to be lower. This was removed once, on the
// reasoning that the shared bottom edge made the drop unnecessary, and it took
// the middle of the line with it.
//
// What must NOT grow into that room is the mass. A 3pt black lip below the menu
// bar is far more visible than a 1pt white line, and that is what read as the
// whole surface sitting low in a windowed app.
check("the mass is exactly menu-bar height", near(rimMass.height, notched.barHeight))
check("...and the window is taller than the mass, by the drop and only that",
      near(rimMass.totalHeight, rimMass.height + NotchGeometry.rimDrop)
          && NotchGeometry.rimDrop > 0)

let rimRect = CGRect(x: 0, y: 0, width: rimMass.width, height: rimMass.totalHeight)
let rim = BarRim(placement: rimMass)

// ONE LINE, END TO END. It was two lines stopping either side of the housing;
// that left the surface looking cut in half. Continuous reads as one object.
check("the rim is ONE continuous line, not two", subpaths(rim.path(in: rimRect)) == 1)
check("it runs the full width of the mass",
      near(rim.path(in: rimRect).boundingRect.minX, rimRect.minX, 0.01)
          && near(rim.path(in: rimRect).boundingRect.maxX, rimRect.maxX, 0.01))

// WHERE IT PASSES THE HARDWARE IT IS UNDERNEATH IT, and that is the whole
// trick: the line never touches the housing's edge, it goes below it.
// THE BOTTOM IS ONE STRAIGHT LINE, END TO END.
//
// It used to run along the shoulders' floor and dip under the housing to cross
// — which cleared the hardware but left a stepped line with two kinks in it.
// Dropping the WHOLE line by the same amount clears the housing just as well
// and reads as one edge instead of three segments.
check("the bottom of the line clears the housing rather than hiding inside it",
      BarRim.floorY(in: rimRect, rimMass) > rimRect.minY + rimMass.height)
check("...and that is the only y the bottom ever has — one straight run, no step",
      near(BarRim.floorY(in: rimRect, rimMass), rimRect.maxY, 0.01))

// The line lands inside whatever rect it is handed: the view insets it by half
// a stroke width so the whole stroke stays on screen, and an absolute y derived
// from the mass height would have fallen outside that.
let insetRect = rimRect.insetBy(dx: 0.5, dy: 0.5)
check("the whole line stays inside a rect the view has inset",
      BarRim(placement: rimMass).path(in: insetRect).boundingRect.maxY <= insetRect.maxY + 0.01)

// A shoulder that is not there must not be traced anyway: with one empty the
// mass ends just past the housing, and the line simply outlines what is there.
let oneSided = notched.mass(left: 98, right: 0, rimDrop: NotchGeometry.rimDrop)
let oneRect = CGRect(x: 0, y: 0, width: oneSided.width, height: oneSided.totalHeight)
check("with one shoulder empty the line still closes at the mass's corner",
      BarRim(placement: oneSided).path(in: oneRect).boundingRect.maxX <= oneRect.maxX + 0.01)

// It travels with the rect it is given: the view insets the rim by half a
// stroke width so the whole line stays on screen, which moves the origin.
let shifted = CGRect(x: 10, y: 0, width: rimMass.width, height: rimMass.totalHeight)
check("the line still spans its rect when the rect is shifted",
      near(rim.path(in: shifted).boundingRect.minX, shifted.minX, 0.01))

// A mass with no shoulders is the collapse animation's last frame. It must
// degenerate to nothing rather than draw a lone underline in the cutout.
check("a mass with no shoulders draws nothing",
      subpaths(rim0.path(in: rimRect)) == 0)

// ── WHEN THE SURFACE MAY PUT ITSELF DOWN ──
//
// Dormant is the CUTOUT on a notched Mac, so "rest" and "hide behind the
// camera" are the same instruction. Anything the user explicitly asked to see
// must therefore survive every self-initiated rest, and the pocket is the one
// that did not: click the notch, watch the card for one second, and the
// stand-down clock posted it into the hole (field log 18 Sep 20:20:41).
check("an open pocket is never rested away",
      !SurfaceRest.mayRest(current: .bar, pocketOpen: true)
          && !SurfaceRest.mayRest(current: .expanded, pocketOpen: true)
          && !SurfaceRest.mayRest(current: .dormant, pocketOpen: true))
check("a bar with nothing holding it up still rests",
      SurfaceRest.mayRest(current: .bar, pocketOpen: false))
check("a panel the user opened is not ours to collapse",
      !SurfaceRest.mayRest(current: .expanded, pocketOpen: false))
check("...but a dormant surface still records the sentence as said",
      SurfaceRest.mayRest(current: .dormant, pocketOpen: false))
check("a suppressed repeat leaves an open pocket exactly where it is",
      BannerRepeat.landing(current: .bar, pocketOpen: true) == .stayPut)
check("a dismissal with the pocket open comes down to the BAR, not the cutout",
      BannerRepeat.landing(current: .expanded, pocketOpen: true) == .settleAtBar)
check("and without one it still settles all the way",
      BannerRepeat.landing(current: .expanded, pocketOpen: false) == .restSilently
          && BannerRepeat.landing(current: .bar, pocketOpen: false) == .restSilently)
check("already dormant stays put", BannerRepeat.landing(current: .dormant, pocketOpen: false) == .stayPut)

// ── AND WHETHER DORMANT IS SOMEWHERE THE SURFACE MAY GO AT ALL ──
//
// Dormant is a PLACE, not a rung: the cutout. It needs a cutout to exist, and
// it needs to be empty. The pocket chord opens the card at exactly the moment
// no task is running, which is the moment the engine's reconcile calls the
// surface empty — so the card went into the hole and the gesture did nothing
// visible (field log 19 Sep 03:16:13).
check("no cutout, no dormant", !DormantAvailability.available(hasNotch: false, pocketOpen: false))
check("an open pocket occupies it", !DormantAvailability.available(hasNotch: true, pocketOpen: true))
check("...on either display kind", !DormantAvailability.available(hasNotch: false, pocketOpen: true))
check("an empty cutout is dormant's one home",
      DormantAvailability.available(hasNotch: true, pocketOpen: false))

// THE CHORD. Pressed at rest — which is how it is normally used — the pocket
// opens inside the cutout, and the compact rung that would lift it out arrives
// as a suppressed repeat. "Already dormant, nothing to move" was wrong: there
// was. Field log 19 Sep 03:26:47, four and a half seconds in the hole.
check("a suppressed repeat lifts an open pocket OUT of the cutout",
      BannerRepeat.landing(current: .dormant, pocketOpen: true) == .settleAtBar)
check("...and leaves it alone once it is up",
      BannerRepeat.landing(current: .bar, pocketOpen: true) == .stayPut)

print("\nALL DECODE CHECKS PASSED")
