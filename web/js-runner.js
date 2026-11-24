// Runs the code of the test page's JavaScript mode (and of the examples page) in a module worker. The page starts a fresh
// worker for each run and terminates it on Stop or when the run ends, so an endless loop cannot
// hang the page. The code reaches neither the DOM, the page, the access token nor the socket: it
// sends WXF bytes for the page to evaluate and decodes the reply bytes itself. The page shows only
// replies that it got from the kernel itself, named by the id of their request.
//
// page -> worker: { type: 'init', wasm: URL of wxf.wasm or wxf64.wasm, code }
//                 { type: 'reply', id, bytes } or { type: 'reply', id, error }
//                 { type: 'rendered', id, ok }     ok: false if the page no longer keeps that reply
// worker -> page: { type: 'eval', id, bytes }       WXF of an expression to evaluate
//                 { type: 'render', id, of, label } show the reply to request `of` like a Wolfram-mode result
//                 { type: 'console', level, text }  { type: 'dropped', count } (console lines not sent)
//                 { type: 'result', text }          { type: 'error', text }          { type: 'done' }
import { WXF } from './wxf.js'
import { toReply } from './wolfram-socket.js'
import {
  W, WArray, WAssociation, WBigReal, WFunction, WReal, WSymbol, fn, formatValue, isWolframValue, real, requestOf, sym,
  toInputForm, toJS,
} from './js-helpers.js'

const MAX_IN_FLIGHT = 8   // requests sent to the page at once (it ends a run that sends more); the others wait here
const MAX_LINES = 1000    // console lines sent to the page; further ones are only counted
const MAX_REQUEST = 8 * 1024 ** 2   // bytes of a request (the page ends a run that sends a larger one)
const post = (message, transfer) => self.postMessage(message, transfer || [])

let wxf
let nextId = 1
const waiting = new Map()          // id -> { resolve, reject } of requests sent to the page
const rendering = new Map()        // id -> resolve of render requests
const queue = []                   // requests waiting for a free slot
// results (objects) of this run -> { id of their request, their WXF when they came, shown }: a
// result is shown from its reply only while it is unchanged (JS code can change arrays in place),
// since evaluating it again may be refused (a plot's Graphics holds options outside the allowlist)
const kept = new WeakMap()

class WolframError extends Error {
  constructor(reply) {
    super(`${reply.failure}: ${reply.message}${reply.symbols?.length ? ` ${reply.symbols.join(', ')}` : ''}`)
    this.name = 'WolframError'
    this.failure = reply.failure
    this.symbols = reply.symbols
    this.reply = reply
  }
}

function pump() {
  while (waiting.size < MAX_IN_FLIGHT && queue.length) {
    const request = queue.shift()
    const id = nextId++
    waiting.set(id, request)
    post({ type: 'eval', id, bytes: request.bytes }, [request.bytes.buffer])
  }
}

function receive({ id, bytes, error }) {
  const request = waiting.get(id)
  if (!request) return
  waiting.delete(id)
  pump()
  if (typeof error === 'string') return request.reject(new WolframError({ failure: 'Error', message: error }))
  try {
    const reply = { ...toReply(wxf.decode(bytes)), bytes }
    const r = reply.result
    if (reply.success && r !== null && typeof r === 'object') {
      try { kept.set(r, { id, snapshot: wxf.encode(r), shown: false }) } catch {}   // not kept: shown by evaluating it again
    }
    request.resolve({ reply, id })
  } catch (err) {
    request.reject(err)
  }
}

/** Sends WXF bytes; resolves to { reply, id } */
const send = bytes => new Promise((resolve, reject) => {
  if (bytes.length > MAX_REQUEST) throw new RangeError(`a request must be at most ${MAX_REQUEST} bytes of WXF, not ${bytes.length}`)
  queue.push({ bytes, resolve, reject })
  pump()
})

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])
/** The kept entry of a result of this run that is still as it came (bytes: its WXF now) */
const unchanged = (value, bytes) => {
  const k = value !== null && typeof value === 'object' ? kept.get(value) : undefined
  return k && sameBytes(k.snapshot, bytes) ? k : undefined
}

/** Asks the page to show the reply to request `of`; resolves to false if the page no longer has it */
const render = (of, expr) => new Promise(resolve => {
  const id = nextId++
  rendering.set(id, resolve)
  post({ type: 'render', id, of, label: label(expr) })
})

// line of the user's code in a stack trace: the code is the body of an AsyncFunction, whose source
// starts with two lines of its own (V8: "<anonymous>:L:C", Firefox: "> AsyncFunction:L:C")
const userLine = stack => {
  const m = /(?:<anonymous>|> AsyncFunction):(\d+):\d+/.exec(String(stack || ''))
  return m && Number(m[1]) > 2 ? Number(m[1]) - 2 : null
}
const failed = (reply, site) => Object.assign(new WolframError(reply), { line: userLine(site.stack) })

const label = expr => typeof expr === 'string' ? expr.slice(0, 300) : formatValue(expr, 300)

/** wl(expr) or wl`text ${value}`: the result of evaluating it; rejects with a WolframError on a failure */
async function wl(...args) {
  const site = new Error()   // the line of the call, for the failure
  const { reply } = await send(wxf.encode(requestOf(args)))
  if (!reply.success) throw failed(reply, site)
  return reply.result
}
/** wl.reply(expr): the whole reply, also for failures (async: values that cannot be encoded reject) */
wl.reply = async (...args) => (await send(wxf.encode(requestOf(args)))).reply

/** show(expr): evaluates expr and shows the result like the Wolfram mode; resolves to the result */
async function show(...args) {
  const site = new Error()
  const expr = requestOf(args)
  const bytes = wxf.encode(expr)
  const k = unchanged(expr, bytes)
  if (k && await render(k.id, expr)) {   // a result of this run, unchanged: shown from its reply
    k.shown = true
    return expr
  }
  const { reply, id } = await send(bytes)
  const rendered = await render(id, expr)
  if (!rendered) say('warn', ['show: the page no longer keeps this reply (too many large results at once)'])
  // a failure that the page shows already is not shown again if the code does not catch it
  if (!reply.success) throw Object.assign(failed(reply, site), { shown: rendered })
  const shown = kept.get(reply.result)
  if (shown) shown.shown = true
  return reply.result
}

let lines = 0, dropped = 0, droppedAt = 0
function say(level, args) {
  if (lines < MAX_LINES) {
    lines++
    return post({ type: 'console', level, text: args.map(a => formatValue(a)).join(' ').slice(0, 10000) })
  }
  dropped++
  // the count of dropped lines, at most five times a second
  if (Date.now() - droppedAt > 200) { droppedAt = Date.now(); post({ type: 'dropped', count: dropped }) }
}
for (const level of ['log', 'info', 'debug', 'warn', 'error']) console[level] = (...args) => say(level, args)

const describe = err => {
  if (!(err instanceof Error)) return `Uncaught ${formatValue(err, 2000)}`
  const line = err.line ?? userLine(err.stack)
  return `Uncaught ${err.name}: ${err.message}${line ? ` (line ${line})` : ''}`
}
// errors that the code does not await (timers, promises nobody waits for) are shown, and the run goes on
self.addEventListener('unhandledrejection', e => {
  e.preventDefault()
  if (e.reason?.shown !== true) say('error', [describe(e.reason).replace('Uncaught', 'Uncaught (in promise)')])
})
self.addEventListener('error', e => { e.preventDefault(); say('error', [describe(e.error ?? e.message)]) })

const SCOPE = { W, wl, show, sym, fn, real, toInputForm, toJS, WSymbol, WFunction, WReal, WBigReal, WAssociation, WArray }
const AsyncFunction = (async () => {}).constructor

async function run(code) {
  // the code is the body of an async function: await works, and return gives the value to show
  const body = new AsyncFunction(...Object.keys(SCOPE), code)
  const value = await body(...Object.values(SCOPE))
  if (value === undefined) return
  const k = value !== null && typeof value === 'object' ? kept.get(value) : undefined
  if (k?.shown && unchanged(value, wxf.encode(value))) return   // shown by show() and unchanged: not twice (return show(...))
  if (k || isWolframValue(value)) await show(value)
  else post({ type: 'result', text: formatValue(value) })
}

self.onmessage = async ({ data }) => {
  if (data?.type === 'reply') return receive(data)
  if (data?.type === 'rendered') {
    const resolve = rendering.get(data.id)
    rendering.delete(data.id)
    return resolve?.(data.ok === true)
  }
  if (data?.type !== 'init' || wxf) return
  try {
    wxf = await WXF.load(new URL(data.wasm, location.href))
    await run(String(data.code))
  } catch (err) {
    if (err?.shown !== true) post({ type: 'error', text: describe(err) })
  }
  if (dropped) post({ type: 'dropped', count: dropped })
  post({ type: 'done' })
}
