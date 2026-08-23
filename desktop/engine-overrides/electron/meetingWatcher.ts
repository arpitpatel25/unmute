import { isMeetingAppBundleId, isMeetingTabUrl } from './meetingApps'
import type { NowPlaying } from './mediaPause'

export type MeetingSample = { nowPlaying: NowPlaying; activeTabUrl?: string }
export type MeetingWatcherEvents = {
  onMeetingStarted: () => void
  onMeetingEnded: () => void
}

const DEFAULT_DEBOUNCE_MS = 1500

/**
 * Two INDEPENDENT signals, checked in this order on purpose.
 *
 * THE TAB URL IS NOT GATED ON now-playing. `readNowPlaying()` reports the
 * system MPNowPlayingInfoCenter item — what Music, Spotify and video players
 * publish. Zoom, Google Meet, Teams and Webex publish nothing there; they
 * just open an audio unit. So during a real meeting `nowPlaying.playing` is
 * false in almost every case, and checking it first (as this did)
 * short-circuited to `false` before the tab URL was ever looked at — which
 * silently disabled the ENTIRE browser-tab detection path (spec §3,
 * Safari/Edge/Brave/Arc via AppleScript). A URL that matches a meeting is a
 * meeting signal on its own; nothing about "is something playing" makes it
 * more or less true.
 *
 * The bundle-ID signal below still keeps its `playing` gate: a meeting app
 * merely being open is not evidence of a call, and that gate is what
 * distinguishes "Zoom is running" from "Zoom is in a meeting".
 */
function sampleLooksLikeMeeting(sample: MeetingSample): boolean {
  if (isMeetingTabUrl(sample.activeTabUrl)) return true
  if (!sample.nowPlaying.playing) return false
  if (isMeetingAppBundleId(sample.nowPlaying.bundleIdentifier)) return true
  return false
}

/**
 * Debounced meeting-active signal (spec §2). Fed periodically with the
 * latest readNowPlaying()/tab-URL sample; fires onMeetingStarted/onMeetingEnded
 * only once the signal has held steady for `debounceMs`, so a momentarily
 * idle Zoom window or a single stray audio blip doesn't trigger a prompt.
 */
export class MeetingWatcher {
  private readonly events: MeetingWatcherEvents
  private readonly debounceMs: number
  private readonly now: () => number
  private active = false
  private pendingSince: number | null = null
  private pendingValue: boolean | null = null

  constructor(events: MeetingWatcherEvents, debounceMs: number = DEFAULT_DEBOUNCE_MS, now: () => number = Date.now) {
    this.events = events
    this.debounceMs = debounceMs
    this.now = now
  }

  get isMeetingActive(): boolean {
    return this.active
  }

  feed(sample: MeetingSample): void {
    const looksLikeMeeting = sampleLooksLikeMeeting(sample)
    if (looksLikeMeeting === this.active) {
      // Signal agrees with current state — nothing pending, reset any stale pending transition.
      this.pendingSince = null
      this.pendingValue = null
      return
    }

    const t = this.now()
    if (this.pendingValue !== looksLikeMeeting) {
      this.pendingValue = looksLikeMeeting
      this.pendingSince = t
      return
    }

    if (this.pendingSince !== null && t - this.pendingSince >= this.debounceMs) {
      this.active = looksLikeMeeting
      this.pendingSince = null
      this.pendingValue = null
      if (looksLikeMeeting) {
        this.events.onMeetingStarted()
      } else {
        this.events.onMeetingEnded()
      }
    }
  }
}
