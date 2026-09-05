import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prepareChatImage, validateChatImage } from './image-validation'

const fixtures = {
  'image/jpeg': '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAQKADAAQAAAABAAAAQAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAQABAAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQABP/aAAwDAQACEQMRAD8A+L6KKK/lM/38CiiigAooooAKKKKAP//Q+L6KKK/lM/38CiiigAooooAKKKKAP//R+L6KKK/lM/38CiiigAooooAKKKKAP//S+L6KKK/lM/38CiiigAooooAKKKKAP//Z',
  'image/png': 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC',
  'image/gif': 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'image/webp': 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA',
}

test('macOS attachment decoder accepts real PNG, JPEG, GIF and WebP bytes', { skip: process.platform !== 'darwin' }, async () => {
  for (const [mime, encoded] of Object.entries(fixtures)) {
    try { assert.equal(await validateChatImage(Buffer.from(encoded, 'base64'), mime), mime) }
    catch (error) { throw new Error(`Failed fixture ${mime}`, { cause: error }) }
  }
})

test('decoded format wins over a mismatched claimed MIME', { skip: process.platform !== 'darwin' }, async () => {
  assert.equal(await validateChatImage(Buffer.from(fixtures['image/png'], 'base64'), 'image/jpeg'), 'image/png')
})

test('staging contract carries detected MIME, owned suffix and original display name together', { skip: process.platform !== 'darwin' }, async () => {
  const bytes = Buffer.from(fixtures['image/png'], 'base64')
  for (const name of ['clipboard-image', 'photo.txt', 'photo.jpg']) {
    assert.deepEqual(await prepareChatImage(bytes, 'image/jpeg', name), { mimeType: 'image/png', extension: 'png', name })
  }
})

test('corrupt image content is rejected with a readable error for every advertised format', { skip: process.platform !== 'darwin' }, async () => {
  for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
    await assert.rejects(validateChatImage(Buffer.from('not an image'), mime), /corrupt|decoded/)
  }
})
