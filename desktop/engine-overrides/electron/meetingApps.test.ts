import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { isMeetingAppBundleId, isMeetingTabUrl } from './meetingApps'

describe('meeting-app bundle ID matching', () => {
  test('matches Zoom', () => {
    assert.equal(isMeetingAppBundleId('us.zoom.xos'), true)
  })
  test('matches Microsoft Teams', () => {
    assert.equal(isMeetingAppBundleId('com.microsoft.teams2'), true)
  })
  test('matches Webex', () => {
    assert.equal(isMeetingAppBundleId('Cisco-Systems.Spark'), true)
  })
  test('does not match an unrelated bundle id', () => {
    assert.equal(isMeetingAppBundleId('com.spotify.client'), false)
  })
  test('does not match undefined', () => {
    assert.equal(isMeetingAppBundleId(undefined), false)
  })
  test('browser bundle ids are never meeting apps by themselves', () => {
    assert.equal(isMeetingAppBundleId('com.google.Chrome'), false)
    assert.equal(isMeetingAppBundleId('com.apple.Safari'), false)
  })
})

describe('meeting tab URL matching', () => {
  test('matches a Google Meet call URL', () => {
    assert.equal(isMeetingTabUrl('https://meet.google.com/abc-defg-hij'), true)
  })
  test('matches a Zoom web-join URL', () => {
    assert.equal(isMeetingTabUrl('https://us05web.zoom.us/j/1234567890'), true)
  })
  test('matches a Teams web URL', () => {
    assert.equal(isMeetingTabUrl('https://teams.microsoft.com/l/meetup-join/abc'), true)
  })
  test('does not match the Meet marketing homepage query-less root', () => {
    assert.equal(isMeetingTabUrl('https://meet.google.com/'), false)
  })
  test('does not match an unrelated URL', () => {
    assert.equal(isMeetingTabUrl('https://www.youtube.com/watch?v=abc'), false)
  })
  test('does not match undefined', () => {
    assert.equal(isMeetingTabUrl(undefined), false)
  })
})
