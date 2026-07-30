import Foundation

func check(_ name: String, _ ok: Bool) {
    print("\(ok ? "PASS" : "FAIL")  \(name)")
    if !ok { exit(1) }
}

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

// The unarmed fast path: a `pill` line must still decode exactly as before.
guard case let .pill(ps) = Command.decode(#"{"type":"pill","state":{"phase":"recording","elapsed":3}}"#) else { check("pill still decodes", false); exit(1) }
check("pill still decodes", ps.phase == .recording && ps.elapsed == 3)

print("\nALL DECODE CHECKS PASSED")
