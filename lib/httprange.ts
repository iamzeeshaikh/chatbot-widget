// Serve bytes the way an <audio> element needs them.
//
// WHY THIS EXISTS: a voice note played back as "0:00 / 0:00" with a dead
// scrubber. Nothing was wrong with the audio — the browser simply could not
// work out how long it was. Our media endpoints streamed Twilio's response
// body straight through, which sends no `Content-Length` and answers no range
// request, and an OGG/opus stream carries no duration in its header either. So
// the player had no way to know the length until it had played to the end,
// and seeking was impossible.
//
// Buffering first and answering ranges fixes both at once. The files are small
// by definition — WhatsApp caps media at 16MB and a minute of speech at 16kHz
// is well under a hundred kilobytes — so holding one in memory is cheaper than
// the round trips a range-less player makes trying to cope.

import { NextRequest, NextResponse } from 'next/server'

/** A view onto a buffer is not a valid response body under this TS config, so
 *  the exact bytes are copied out as a standalone ArrayBuffer. */
function body(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
}

export function serveBytes(
  req: NextRequest,
  bytes: Uint8Array,
  opts: { type: string; filename?: string; cache?: string },
): NextResponse {
  const total = bytes.byteLength
  const base: Record<string, string> = {
    'Content-Type': opts.type || 'application/octet-stream',
    // Without this the browser does not even ask for a range, so a player that
    // could seek still won't.
    'Accept-Ranges': 'bytes',
    'Cache-Control': opts.cache ?? 'private, max-age=300',
  }
  if (opts.filename) {
    base['Content-Disposition'] = `inline; filename="${opts.filename.replace(/"/g, '')}"`
  }

  const header = req.headers.get('range')
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null
  if (m && total > 0) {
    let start = m[1] ? Number(m[1]) : NaN
    let end = m[2] ? Number(m[2]) : NaN
    if (Number.isNaN(start)) {
      // "bytes=-500" — the LAST 500 bytes. Players use this to read a trailing
      // index, and reading it as "from byte 0" returns the wrong data silently.
      const suffix = Number.isNaN(end) ? 0 : end
      start = Math.max(0, total - suffix)
      end = total - 1
    } else if (Number.isNaN(end)) {
      end = total - 1
    }
    if (start >= total || start > end) {
      return new NextResponse(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${total}` } })
    }
    end = Math.min(end, total - 1)
    const slice = bytes.subarray(start, end + 1)
    return new NextResponse(body(slice), {
      status: 206,
      headers: { ...base, 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': String(slice.byteLength) },
    })
  }

  return new NextResponse(body(bytes), { status: 200, headers: { ...base, 'Content-Length': String(total) } })
}
