// Client for the bridge: one WXF message per request, replies in request order.
import { WAssociation, WReal, WSymbol, WXF } from './wxf.js'

export class WolframSocket {
  /**
   * url: ws:// or wss:// URL of the bridge's /ws endpoint, including ?token=...
   * wxf: a loaded WXF instance (loaded from ./wxf.wasm when omitted)
   */
  static async open(url, wxf) {
    wxf = wxf || await WXF.load()
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    await new Promise((resolve, reject) => {
      ws.onopen = resolve
      ws.onerror = () => reject(new Error(`cannot connect to ${url}`))
    })
    return new WolframSocket(ws, wxf)
  }

  constructor(ws, wxf) {
    this.ws = ws
    this.wxf = wxf
    this.pending = []
    this.onclose = null
    ws.onerror = null
    ws.onmessage = event => {
      const request = this.pending.shift()
      if (!request) return
      try {
        const bytes = new Uint8Array(event.data)
        request.resolve({ ...toReply(this.wxf.decode(bytes)), bytes })
      } catch (err) {
        request.reject(err)
      }
    }
    ws.onclose = event => {
      for (const request of this.pending.splice(0)) request.reject(new Error(`connection closed (${event.code})`))
      if (this.onclose) this.onclose(event)
    }
  }

  /**
   * Evaluates an expression on the server. A string is sent as Wolfram Language input and parsed
   * there; anything else is encoded as an expression (see wxf.js).
   * Resolves to { success, result, inputForm, messages, timing, tex, image, format } or
   * { success: false, failure, message, symbols }; `raw` holds the decoded reply and `bytes` its
   * WXF bytes (for passing the reply on, e.g. to a worker, which decodes it with toReply).
   * result: undefined for a result larger than the kernel's $ResultLimit (inputForm is then
   * '-LargeResult-'); tex: the result as TeX (for KaTeX), absent for pictures; image:
   * { format: 'SVG', data: string } for graphics or { format: 'PNG', data: Uint8Array } for raster
   * images (see imageURL); format: why neither came, when formatting ran out of time or memory
   * ('TimeLimit', 'MemoryLimit' or 'Aborted').
   */
  evaluate(input) {
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('the connection is not open'))
    return this.evaluateWXF(this.wxf.encode(input))
  }

  /**
   * Like evaluate, for a request already encoded as WXF bytes (Uint8Array starting with "8:"),
   * e.g. by another WXF instance in a worker. evaluate(Uint8Array) still sends a ByteArray.
   */
  evaluateWXF(bytes) {
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('the connection is not open'))
    if (!(bytes instanceof Uint8Array)) return Promise.reject(new TypeError('evaluateWXF takes a Uint8Array of WXF'))
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject })
      this.ws.send(bytes)
    })
  }

  close() { this.ws.close() }
}

/**
 * The reply object (see evaluate, without `bytes`) of a decoded reply from the bridge: for code
 * that decodes the reply bytes itself, such as a worker given them by the page.
 */
export function toReply(raw) {
  if (!(raw instanceof WAssociation)) throw new Error('unexpected reply from the server')
  const o = raw.toObject()
  const success = o.Success instanceof WSymbol && o.Success.name === 'True'
  if (!success) return { success, failure: o.Failure, message: o.Message, symbols: o.Symbols || [], raw }
  const image = o.Image instanceof WAssociation ? o.Image.toObject() : {}
  const pictureOK = (image.Format === 'SVG' && typeof image.Data === 'string') ||
    (image.Format === 'PNG' && image.Data instanceof Uint8Array)
  return {
    success,
    result: o.Result,
    inputForm: o.InputForm,
    messages: o.Messages || [],
    timing: o.Timing instanceof WReal ? o.Timing.value : o.Timing,
    tex: typeof o.TeX === 'string' ? o.TeX : undefined,
    image: pictureOK ? { format: image.Format, data: image.Data } : undefined,
    format: typeof o.Format === 'string' ? o.Format : undefined,
    raw,
  }
}

const IMAGE_TYPES = { SVG: 'image/svg+xml', PNG: 'image/png' }

/**
 * An object URL for showing a reply's image in an <img> element. Release it with
 * URL.revokeObjectURL when the element is gone. An <img> never runs scripts inside an SVG.
 */
export function imageURL(image) {
  const type = IMAGE_TYPES[image?.format]
  if (!type) throw new Error('not an image from the bridge')
  return URL.createObjectURL(new Blob([image.data], { type }))
}
