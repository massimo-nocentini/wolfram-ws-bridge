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
        request.resolve(this.#reply(new Uint8Array(event.data)))
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
   * Resolves to { success, result, inputForm, messages, timing } or
   * { success: false, failure, message, symbols }; `raw` holds the decoded reply.
   */
  evaluate(input) {
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('the connection is not open'))
    const bytes = this.wxf.encode(input)
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject })
      this.ws.send(bytes)
    })
  }

  close() { this.ws.close() }

  #reply(bytes) {
    const raw = this.wxf.decode(bytes)
    if (!(raw instanceof WAssociation)) throw new Error('unexpected reply from the server')
    const o = raw.toObject()
    const success = o.Success instanceof WSymbol && o.Success.name === 'True'
    if (!success) return { success, failure: o.Failure, message: o.Message, symbols: o.Symbols || [], raw }
    return {
      success,
      result: o.Result,
      inputForm: o.InputForm,
      messages: o.Messages || [],
      timing: o.Timing instanceof WReal ? o.Timing.value : o.Timing,
      raw,
    }
  }
}
