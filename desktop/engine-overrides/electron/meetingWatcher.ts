import { isMeetingAppBundleId, isMeetingTabUrl } from './meetingApps'
import type { NowPlaying } from './mediaPause'

export type MeetingSample = { nowPlaying: NowPlaying; activeTabUrl?: string }
export type MeetingWatcherEvents = {
  onMeetingStarted: () => void
  onMeetingEnded: () => void
}

const DEFAULT_DEBOUNCE_MS = 1500

function sampleLooksLikeMeeting(sample: MeetingSample): boolean {
  if (!sample.nowPlaying.playing) return false
  if (isMeetingAppBundleId(sample.nowPlaying.bundleIdentifier)) return true
  if (isMeetingTabUrl(sample.activeTabUrl)) return true
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
