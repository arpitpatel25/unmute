import Foundation

// THE ROUTINE EDITOR'S PURE HALF.
//
// Spec: docs/superpowers/specs/2026-09-14-agent-routines-design.md
//
// The inline editor in the routines sheet shows a schedule and a window as
// pickers, but the engine only ever stores their canonical grammar text (see
// schedule.ts `parseSchedule`/`formatSchedule` and window.ts `parseWindow`).
// These two drafts are the round trip: text → picker state → text. Anything
// they do not recognise falls back to a safe default and says so, so the form
// can still show the raw text it replaced.

public enum RoutineFrequency: String, CaseIterable, Sendable {
    case daily, weekdays, weekends, specificDays, everyHours, everyMinutes, meetingNotes

    public var label: String {
        switch self {
        case .daily:        return "Daily"
        case .weekdays:     return "Weekdays"
        case .weekends:     return "Weekends"
        case .specificDays: return "Specific days"
        case .everyHours:   return "Every N hours"
        case .everyMinutes: return "Every N minutes"
        case .meetingNotes: return "When meeting notes are ready"
        }
    }

    public var usesClock: Bool { self == .daily || self == .weekdays || self == .weekends || self == .specificDays }
}

public struct RoutineScheduleDraft: Equatable, Sendable {
    /// Mon…Sun, in the order the chips draw.
    public static let dayKeys = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
    public static let dayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    public static let hourRange = 1...24
    public static let minuteRange = 15...720
    public static let minuteStep = 15

    public var frequency: RoutineFrequency = .daily
    public var hour = 9
    public var minute = 0
    /// Indexes into `dayKeys` (0 = Mon).
    public var days: Set<Int> = [0]
    public var everyHours = 1
    public var everyMinutes = 30
    /// False when the parsed text was not understood and the defaults stand in.
    public var recognised = true

    public init() {}

    public static func parse(_ raw: String) -> RoutineScheduleDraft {
        var draft = RoutineScheduleDraft()
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            .split(whereSeparator: { $0 == " " || $0 == "\t" }).joined(separator: " ")
        if text == "on meeting-notes-ready" { draft.frequency = .meetingNotes; return draft }

        let parts = text.split(separator: " ").map(String.init)
        if parts.count == 3, parts[0] == "every", let n = Int(parts[1]) {
            if parts[2] == "hour" || parts[2] == "hours", hourRange.contains(n) {
                draft.frequency = .everyHours; draft.everyHours = n; return draft
            }
            if parts[2] == "minute" || parts[2] == "minutes", minuteRange.contains(n) {
                draft.frequency = .everyMinutes; draft.everyMinutes = n; return draft
            }
            return unrecognised()
        }
        guard parts.count == 2, let time = parseTime(parts[1]) else { return unrecognised() }
        draft.hour = time.hour; draft.minute = time.minute
        switch parts[0] {
        case "daily":    draft.frequency = .daily
        case "weekdays": draft.frequency = .weekdays
        case "weekends": draft.frequency = .weekends
        default:
            var days = Set<Int>()
            for part in parts[0].split(separator: ",") {
                let key = String(part.prefix(3))
                guard let index = dayKeys.firstIndex(of: key) else { return unrecognised() }
                days.insert(index)
            }
            guard !days.isEmpty else { return unrecognised() }
            draft.frequency = .specificDays; draft.days = days
        }
        return draft
    }

    /// The canonical text `parseSchedule` accepts.
    public var text: String {
        switch frequency {
        case .daily:        return "daily \(clock)"
        case .weekdays:     return "weekdays \(clock)"
        case .weekends:     return "weekends \(clock)"
        case .specificDays:
            // Canonical like formatSchedule: the named sets collapse, and days
            // run Sun…Sat, so an unchanged schedule saves as identical text.
            if days == Set(0...6) { return "daily \(clock)" }
            if days == Set(0...4) { return "weekdays \(clock)" }
            if days == [5, 6] { return "weekends \(clock)" }
            let keys = days.sorted { ($0 + 1) % 7 < ($1 + 1) % 7 }.map { Self.dayKeys[$0] }
            return "\((keys.isEmpty ? ["mon"] : keys).joined(separator: ",")) \(clock)"
        case .everyHours:   return "every \(everyHours) hours"
        case .everyMinutes:
            return everyMinutes % 60 == 0 ? "every \(everyMinutes / 60) hours" : "every \(everyMinutes) minutes"
        case .meetingNotes: return "on meeting-notes-ready"
        }
    }

    public var clock: String { String(format: "%02d:%02d", hour, minute) }

    private static func unrecognised() -> RoutineScheduleDraft {
        var draft = RoutineScheduleDraft()
        draft.recognised = false
        return draft
    }

    private static func parseTime(_ s: String) -> (hour: Int, minute: Int)? {
        let pieces = s.split(separator: ":")
        guard pieces.count == 2, pieces[1].count == 2, let h = Int(pieces[0]), let m = Int(pieces[1]),
              (0...23).contains(h), (0...59).contains(m) else { return nil }
        return (h, m)
    }
}

public enum RoutineWindowChoice: String, CaseIterable, Sendable {
    case yesterdayOrLastRun, sinceLastRun, today, lastHours, lastDays, none

    public var label: String {
        switch self {
        case .yesterdayOrLastRun: return "Since yesterday"
        case .sinceLastRun:       return "Since the last run"
        case .today:              return "Today"
        case .lastHours:          return "Last N hours"
        case .lastDays:           return "Last N days"
        case .none:               return "No time period"
        }
    }
}

public struct RoutineWindowDraft: Equatable, Sendable {
    public static let hourRange = 1...720
    public static let dayRange = 1...30

    public var choice: RoutineWindowChoice = .yesterdayOrLastRun
    public var hours = 24
    public var days = 7

    public init() {}

    public static func parse(_ raw: String) -> RoutineWindowDraft {
        var draft = RoutineWindowDraft()
        let parts = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            .split(separator: " ").map(String.init)
        switch parts.first {
        case "yesterday-or-last-run": draft.choice = .yesterdayOrLastRun
        case "since-last-run":        draft.choice = .sinceLastRun
        case "today":                 draft.choice = .today
        case "none":                  draft.choice = .none
        case "last" where parts.count == 3:
            guard let n = Int(parts[1]) else { break }
            if parts[2].hasPrefix("hour"), hourRange.contains(n) { draft.choice = .lastHours; draft.hours = n }
            else if parts[2].hasPrefix("day"), dayRange.contains(n) { draft.choice = .lastDays; draft.days = n }
        default: break
        }
        return draft
    }

    /// The canonical text `parseWindow` accepts.
    public var text: String {
        switch choice {
        case .yesterdayOrLastRun: return "yesterday-or-last-run"
        case .sinceLastRun:       return "since-last-run"
        case .today:              return "today"
        case .lastHours:          return "last \(hours) \(hours == 1 ? "hour" : "hours")"
        case .lastDays:           return "last \(days) \(days == 1 ? "day" : "days")"
        case .none:               return "none"
        }
    }
}
