/**
 * Image bridge between DSH's durable attachments and Accio's Gemini-shaped
 * `contents.parts`.
 *
 * DSH keeps pasted screenshots as files under
 *   ~/.dsh/attachments/v1/objects/<first-two-hex>/<sha256-hex>
 * and an `image` content block carries only an `ImageAttachmentRef`
 * (`attachmentId: "sha256:...", mediaType, bytes, ...`), never the pixels.
 *
 * pi-ai refuses any request whose messages contain an `image` block unless the
 * host's durable attachment service is injected into the adapter, which this
 * connector does not have. So the adapter rewrites image blocks into short text
 * markers BEFORE pi-ai inspects them, and the loopback shim expands those
 * markers back into real `{ inlineData: { mimeType, data } }` parts. The marker
 * carries only an id and a MIME type, so no base64 ever enters DSH's context
 * or token accounting.
 *
 * This module has no DSH/Accio imports: pure transformation plus one filesystem
 * read, so it can be unit-tested offline with plain node.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const ALLOWED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
export const ATTACHMENT_ID_RE = /^sha256:[0-9a-f]{64}$/i
export const MAX_IMAGES_PER_REQUEST = 4
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024
export const MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024

/** Shared marker grammar. Payload is compact JSON with no `>` characters. */
export const IMAGE_MARKER_RE = /<<ACCIOIMG:([^>]+)>>/g

/** Default DSH v1 attachment object store. */
export function defaultAttachmentsRoot() {
  return join(homedir(), '.dsh', 'attachments', 'v1', 'objects')
}

/** Resolve an `sha256:<hex>` id inside the object store, or undefined. */
export function attachmentPath(root, id) {
  if (typeof id !== 'string' || !ATTACHMENT_ID_RE.test(id)) return undefined
  const hex = id.slice(7).toLowerCase()
  return join(root, hex.slice(0, 2), hex)
}

/**
 * Rewrite typed `image` blocks into short text markers. Returns the original
 * options object untouched when there is nothing to rewrite (text-only path).
 */
export function bridgeOptionsImages(options) {
  if (options === null || typeof options !== 'object' || !Array.isArray(options.messages)) return options
  let changed = false
  const messages = options.messages.map((message) => {
    const content = message?.content
    if (!Array.isArray(content) || !content.some((block) => block?.type === 'image')) return message
    changed = true
    return {
      ...message,
      content: content.map((block) => {
        if (block?.type !== 'image') return block
        const ref = block.attachment
        const id = typeof ref?.attachmentId === 'string' ? ref.attachmentId : ''
        const mime = typeof ref?.mediaType === 'string' ? ref.mediaType : ''
        if (!ATTACHMENT_ID_RE.test(id) || !ALLOWED_IMAGE_MIME.has(mime)) {
          return { type: 'text', text: '[image omitted: unsupported attachment reference]' }
        }
        return {
          type: 'text',
          text: '<<ACCIOIMG:' + JSON.stringify({ v: 1, id, mime, bytes: ref.bytes }) + '>>',
        }
      }),
    }
  })
  return changed ? { ...options, messages } : options
}

/** Parse one marker payload; returns null when it is not a valid v1 marker. */
export function parseImageMarker(raw) {
  let ref
  try {
    ref = JSON.parse(raw)
  } catch {
    return null
  }
  if (ref === null || typeof ref !== 'object' || ref.v !== 1) return null
  if (typeof ref.id !== 'string' || !ATTACHMENT_ID_RE.test(ref.id)) return null
  if (typeof ref.mime !== 'string' || !ALLOWED_IMAGE_MIME.has(ref.mime)) return null
  return ref
}

/**
 * Expand one user content value into Gemini parts. `state` is shared across all
 * messages of a request so the image budget is global. Every failure degrades
 * to a short text note: a missing attachment must never break a text turn.
 */
export function expandUserContent(parts, content, state) {
  const pushText = (text) => {
    if (typeof text === 'string' && text.trim() !== '') parts.push({ text })
  }

  const emitMarker = (raw) => {
    const ref = parseImageMarker(raw)
    if (ref === null) {
      pushText('[image omitted: malformed image marker]')
      return
    }
    if (state.count >= MAX_IMAGES_PER_REQUEST || state.bytes >= MAX_TOTAL_IMAGE_BYTES) {
      pushText('[image omitted: request image budget reached]')
      return
    }
    const path = attachmentPath(state.root, ref.id)
    if (path === undefined) {
      pushText('[image omitted: invalid attachment id]')
      return
    }
    let bytes
    try {
      bytes = readFileSync(path)
    } catch {
      pushText('[image omitted: attachment file not readable]')
      return
    }
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES || state.bytes + bytes.length > MAX_TOTAL_IMAGE_BYTES) {
      pushText('[image omitted: image too large for this request]')
      return
    }
    state.count += 1
    state.bytes += bytes.length
    parts.push({ inlineData: { mimeType: ref.mime, data: bytes.toString('base64') } })
    state.logger?.debug?.('dsh-connect-accio: attached image', { bytes: bytes.length, mime: ref.mime })
  }

  const emitString = (text) => {
    IMAGE_MARKER_RE.lastIndex = 0
    let cursor = 0
    for (const match of text.matchAll(IMAGE_MARKER_RE)) {
      pushText(text.slice(cursor, match.index))
      emitMarker(match[1])
      cursor = match.index + match[0].length
    }
    pushText(text.slice(cursor))
  }

  if (typeof content === 'string') {
    emitString(content)
    return
  }
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      emitString(block.text)
    } else if (block?.type === 'image_url') {
      const url = block.image_url?.url
      const m = typeof url === 'string' ? /^data:([^;]+);base64,(.*)$/s.exec(url) : null
      if (m && ALLOWED_IMAGE_MIME.has(m[1]) && m[2].length > 0) {
        parts.push({ inlineData: { mimeType: m[1], data: m[2] } })
      } else {
        pushText('[image omitted: unsupported image_url]')
      }
    }
  }
}

/** Fresh per-request image budget. */
export function newImageState(root, logger) {
  return {
    root: root ?? defaultAttachmentsRoot(),
    logger,
    count: 0,
    bytes: 0,
  }
}
