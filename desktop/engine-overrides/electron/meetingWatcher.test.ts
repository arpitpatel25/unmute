import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { MeetingWatcher } from './meetingWatcher'

describe('MeetingWatcher debounced detection', () => {
  test('does not fire on a single sample below the debounce window', () => {
    let started = 0
    let clock = 0
    const watcher = new MeetingWatcher({ onMeetingStarted: () => started++, onMeetingEnded: () => {} }, 1500, () => clock)
    watcher.feed({ nowPlaying: { playing: true, bundleIdentifier: 'us.zoom.xos' } })
    assert.equal(started, 0)
    assert.equal(watcher.isMeetingActive, false)
  })

  test('fires onMeetingStarted once the signal holds for the debounce window', () => {
    let started = 0
    let clock = 0
    const watcher = new MeetingWatcher({ onMeetingStarted: () => started++, onMeetingEnded: () => {} }, 1500, () => clock)
    watcher.feed({ nowPlaying: { playing: true, bundleIdentifier: 'us.zoom.xos' } })
    clock = 1600
    watcher.feed({ nowPlaying: { playing: true, bundleIdentifier: 'us.zoom.xos' } })
    assert.equal(started, 1)
    assert.equal(watcher.isMeetingActive, true)
  })

  test('does not re-fire onMeetingStarted while already active', () => {
    let started = 0
    let clock = 0
    const watcher = new MeetingWatcher({ onMeetingStarted: () => started++, onMeetingEnded: () => {} }, 1500, () => clock)
    watcher.feed({ nowPlaying: { playing: true, bundleIdentifier: 'us.zoom.xos' } })
    clock = 1600
    watcher.feed({ nowPlaying: { playing: true, bundleIdentifier: 'us.zoom.xos' } })
    clock = 3200
    watcher.feed({ nowPlaying: { playing: true, bundleIdentifier: 'us.zoom.xos' } })
    assert.equal(started, 1)
  })

  test('fires onMeetingEnded once the signal drops and holds for the debounce window', () => {
    let started = 0
    let ended = 0
    let clock = 0
    const watcher = new MeetingWatcher({ onMeetingStarted: () => started++, onMeetingEnded: () => ended++ }, 1500, () => clock)
    watcher.feed({ nowPlaying: { playing: true, bundleIdentifier: 'us.zoom.xos' } })
    clock = 1600
    watcher.feed({ nowPlaying: { playing: true, bundleIdentifier: 'us.zoom.xos' } })
    clock = 1700
    watcher.feed({ nowPlaying: { playing: false, bundleIdentifier: 'us.zoom.xos' } })
    clock = 3300
    watcher.feed({ nowPlaying: { playing: false, bundleIdentifier: 'us.zoom.xos' } })
    assert.equal(started, 1)
    assert.equal(ended, 1)
    assert.equal(watcher.isMeetingActive, false)
  })

  test('a matching browser tab URL counts as a meeting signal even for a non-meeting-specific bundle id', () => {
    let started = 0
    let clock = 0
    const watcher = new MeetingWatcher({ onMeetingStarted: () => started++, onMeetingEnded: () => {} }, 1500, () => clock)
    watcher.feed({ nowPlaying: { playing: true, bundleIdentifier: 'com.google.Chrome' }, activeTabUrl: 'https://meet.google.com/abc-defg-hij' })
    clock = 1600
    watcher.feed({ nowPlaying: { playing: true, bundleIdentifier: 'com.google.Chrome' }, activeTabUrl: 'https://meet.google.com/abc-defg-hij' })
    assert.equal(started, 1)
  })

  test('Chrome playing audio on a non-meeting tab is not a meeting signal', () => {
    let started = 0
    let clock = 0
    const watcher = new MeetingWatcher({ onMeetingStarted: () => started++, onMeetingEnded: () => {} }, 1500, () => clock)
    watcher.feed({ nowPlaying: { playing: true, bundleIdentifier: 'com.google.Chrome' }, activeTabUrl: 'https://www.youtube.com/watch?v=abc' })
    clock = 1600
    watcher.feed({ nowPlaying: { playing: true, bundleIdentifier: 'com.google.Chrome' }, activeTabUrl: 'https://www.youtube.com/watch?v=abc' })
    assert.equal(started, 0)
  })

  test('a matching browser tab URL counts even when nothing is reported as now-playing', () => {
    // The real-world case: Zoom/Meet/Teams/Webex never publish to
    // MPNowPlayingInfoCenter, so `playing` is false throughout an actual
    // meeting. The tab URL must stand on its own or browser detection never
    // fires at all.
    let started = 0
    let clock = 0
    const watcher = new MeetingWatcher({ onMeetingStarted: () => started++, onMeetingEnded: () => {} }, 1500, () => clock)
    watcher.feed({ nowPlaying: { playing: false }, activeTabUrl: 'https://meet.google.com/abc-defg-hij' })
    clock = 1600
    watcher.feed({ nowPlaying: { playing: false }, activeTabUrl: 'https://meet.google.com/abc-defg-hij' })
    assert.equal(started, 1)
    assert.equal(watcher.isMeetingActive, true)
  })

  test('nowPlaying.playing=false with no tab url is not a meeting signal', () => {
    let started = 0
    let clock = 0
    const watcher = new MeetingWatcher({ onMeetingStarted: () => started++, onMeetingEnded: () => {} }, 1500, () => clock)
    watcher.feed({ nowPlaying: { playing: false, bundleIdentifier: 'us.zoom.xos' } })
    clock = 1600
    watcher.feed({ nowPlaying: { playing: false, bundleIdentifier: 'us.zoom.xos' } })
    assert.equal(started, 0)
  })
})
