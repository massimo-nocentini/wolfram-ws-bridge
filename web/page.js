// What the test page (index.html) and the examples page (examples.html) share: the connection,
// showing a reply (KaTeX, a picture or text, kernel messages, a meta line), and JavaScript runs in a
// worker (js-runner.js) with every check of their messages. One run at a time per page.
import { WXF, toInputForm } from './wxf.js'
import { WolframSocket, imageURL } from './wolfram-socket.js'

export const params = new URLSearchParams(location.search)
export const token = params.get('token') || ''
export const wasmFile = params.get('wasm') === '64' ? 'wxf64.wasm' : 'wxf.wasm'   // ?wasm=64 selects the wasm64 build
const wasmURL = new URL(`./${wasmFile}`, import.meta.url)   // relative: the page's query (the token) is not part of it
const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${encodeURIComponent(token)}`

export let socket = null, wxf = null

/** Loads the codec and opens the socket; status(text) reports progress, changed() runs when the state changes */
export async function connect(status, changed = () => {}) {
  try {
    status(`Loading ${wasmFile}…`)
    wxf = await WXF.load(wasmURL)
    status('Connecting…')
    socket = await WolframSocket.open(url, wxf)
    socket.onclose = e => { status(`Disconnected (${e.code}).`); changed() }
    status(`Connected to ${location.host} (${wxf.wasm64 ? 'wasm64' : 'wasm32'}).`)
    changed()
    return true
  } catch (err) {
    status(`${err.message}${token ? '' : ' (open the URL with ?token=… printed by the server)'}`)
    return false
  }
}

export const connected = () => !!socket && socket.ws.readyState === WebSocket.OPEN

// ---- results ----

// Server strings reach the page only as text, through KaTeX's rendering of TeX, or as an <img>.
// KaTeX's limits are given explicitly: no \href or \url (trust), no huge \rule or \kern (maxSize,
// in em), bounded macro expansion; \arraystretch spaces the rows of matrices of fractions.
const KATEX = { displayMode: true, fleqn: true, throwOnError: false, strict: 'ignore', trust: false, maxSize: 50, maxExpand: 1000 }
const pictureURLs = new WeakMap()   // owner element -> object URLs of its pictures, released with it

export const line = (parent, cls, text) => {
  const d = document.createElement('div')
  d.className = cls
  d.textContent = text
  parent.append(d)
  return d
}

/** Releases the object URLs of the pictures shown for owner (before it is removed or emptied) */
export function releasePictures(owner) {
  for (const src of pictureURLs.get(owner) || []) URL.revokeObjectURL(src)
  pictureURLs.delete(owner)
}

// What renderReply needs of a reply, without its decoded result: a JavaScript run keeps these for
// show(). The "decoded:" text is bounded, since the InputForm of a huge result takes seconds.
export function displayOf(reply) {
  if (!reply.success) return { success: false, failure: reply.failure, message: reply.message, symbols: reply.symbols }
  let detail
  if (reply.image) detail = `${reply.image.format} picture, ${(reply.image.data.length / 1024).toFixed(1)} KB`
  else if (reply.result === undefined) detail = 'result too large to send'
  else {
    try { detail = `decoded: ${toInputForm(reply.result, 300)}` } catch { detail = 'decoded: (too deeply nested to show)' }
  }
  if (reply.format) detail += ` · no picture or TeX (${reply.format})`
  const { inputForm, messages, timing, tex, image } = reply
  return { success: true, inputForm, messages, timing, tex, image, detail }
}

// One reply (a displayOf), in either mode: typeset math, or a picture, or the InputForm text;
// kernel messages; a meta line (before and after: the caller's parts around the kernel time).
// The picture's URL is released with owner (releasePictures).
export function renderReply(box, owner, reply, label, before = [], after = []) {
  if (!reply.success) {
    line(box, 'out err', `${reply.failure}: ${reply.message}${reply.symbols.length ? ' ' + reply.symbols.join(', ') : ''}`)
    return
  }
  if (reply.image) {
    const card = document.createElement('div')
    card.className = 'picture'
    const img = document.createElement('img')
    img.alt = `Picture: ${label}`
    img.src = imageURL(reply.image)
    if (!pictureURLs.has(owner)) pictureURLs.set(owner, [])
    pictureURLs.get(owner).push(img.src)
    // a raster image of a few pixels is enlarged, with visible pixels; the handler keeps only
    // what it needs, not the whole reply
    const isPNG = reply.image.format === 'PNG'
    img.onload = () => {
      if (isPNG && img.naturalWidth < 160) {
        img.classList.add('pixels')
        img.style.width = `${img.naturalWidth * Math.ceil(160 / img.naturalWidth)}px`
      }
      img.onload = null
    }
    card.append(img)
    box.append(card)
  } else if (reply.tex !== undefined && window.katex) {
    const math = line(box, 'math', '')
    katex.render(reply.tex, math, { ...KATEX, macros: { '\\arraystretch': '1.5' } })
    line(box, 'code', reply.inputForm)   // the InputForm stays there to copy
  } else {
    line(box, 'out', reply.inputForm)
  }
  for (const m of reply.messages) line(box, 'msg', m)
  line(box, 'meta', [...before, `${reply.timing.toFixed(4)} s in the kernel`, ...after, reply.detail].join(' · '))
}

// ---- JavaScript runs ----
// The code runs in a fresh module worker (js-runner.js), which gets only the code and the URL of
// the wasm module, never the token or the socket. Its messages are untrusted: each is checked and
// bounded per run, text is shown only as text, and only replies that the page itself got from the
// kernel for the run are shown (the worker names them by id), so TeX and pictures always come
// from the server.

const MAX_LINES = 1000                // console lines shown per run, then a count of the dropped ones
const MAX_SHOWN = 50                  // results shown per run (show() and the returned value)
const MAX_PENDING = 8                 // kernel requests in flight: per run, and of all runs together
const MAX_REQUEST = 8 * 1024 ** 2     // bytes of one request (the server's default --max-message; as in js-runner.js)
const KEEP = 64, KEEP_BYTES = 64 * 1024 ** 2, KEEP_NEWEST = 16   // replies of a run kept for show()
// messages from a run: a burst, then a rate; code that floods the page (self.postMessage in a
// loop) has its run ended. A long text costs more.
const BURST = 5000, RATE = 2000       // messages, messages per second
const clip = (text, max = 10000) => text.length > max ? `${text.slice(0, max)}…` : text
let inKernel = 0                      // run requests not answered yet, of all runs: Stop does not cancel them
let current = null                    // the run in progress

/** The run in progress, or null */
export const currentRun = () => current

/**
 * Runs code in a fresh worker. owner: the element whose dataset.state follows the run ('running',
 * then 'done', 'stopped' or 'failed') and that owns its pictures; output: where its lines and
 * results go; meta: the line for its progress and totals; ended(state): called when it ends.
 */
export function startRun(code, { owner, output, meta, ended = () => {} }) {
  if (current) throw new Error('a run is in progress')
  owner.dataset.state = 'running'
  output.setAttribute('aria-live', 'off')   // screen readers get the meta line at the end, not every console line
  meta.textContent = 'Running…'
  const worker = new Worker(new URL('./js-runner.js', import.meta.url), { type: 'module' })
  const run = { worker, owner, output, meta, ended, start: performance.now(), evaluations: 0, kernel: 0, pending: 0, sent: 0, held: [],
                replies: new Map(), keptBytes: 0, budget: BURST, refilled: performance.now(),
                lines: 0, dropped: 0, reported: 0, droppedLine: null, shown: 0, finished: new Set() }
  current = run
  worker.onmessage = e => receive(run, e.data)
  worker.onerror = e => {
    e.preventDefault()
    if (current !== run) return
    line(output, 'out err', `The worker stopped: ${e.message || 'it could not be started'}`)
    finish(run, 'failed')
  }
  worker.postMessage({ type: 'init', wasm: wasmURL.href, code })
  return run
}

/** Stops the run in progress: its worker is terminated */
export function stopRun() {
  if (current) finish(current, 'stopped')
}

// a message's cost against the run's budget: false once the run has sent too much too fast
function spend(run, cost) {
  const now = performance.now()
  run.budget = Math.min(BURST, run.budget + (now - run.refilled) * RATE / 1000)
  run.refilled = now
  return (run.budget -= cost) >= 0
}

function receive(run, m) {
  if (current !== run || m === null || typeof m !== 'object' || typeof m.type !== 'string') return
  const text = typeof m.text === 'string' ? m.text : typeof m.label === 'string' ? m.label : ''
  // requests are bounded by MAX_PENDING instead: the kernel sets their pace
  if (m.type !== 'eval' && !spend(run, 1 + Math.floor(text.length / 10000))) {
    return abort(run, `The run sent more than ${BURST} messages at once, or more than ${RATE} a second, to the page: ended.`)
  }
  switch (m.type) {
    case 'eval': return evaluateFor(run, m)
    case 'render': return renderFor(run, m)
    case 'console':
      if (typeof m.text === 'string') consoleLine(run, m.level === 'warn' || m.level === 'error' ? 'msg' : 'out', m.text)
      return
    case 'dropped':
      if (Number.isSafeInteger(m.count) && m.count > run.reported) { run.reported = m.count; showDropped(run) }
      return
    case 'result': case 'error':   // once each, at the end of the run
      if (typeof m.text !== 'string' || run.finished.has(m.type)) return
      run.finished.add(m.type)
      line(run.output, m.type === 'error' ? 'out err' : 'out result', clip(m.text))
      return
    case 'done': return finish(run, 'done')
  }
}

const abort = (run, reason) => { line(run.output, 'out err', reason); finish(run, 'failed') }

function consoleLine(run, cls, text) {
  if (run.lines >= MAX_LINES) { run.dropped++; return showDropped(run) }
  run.lines++
  line(run.output, cls, clip(text))
}

function showDropped(run) {
  run.droppedLine ??= line(run.output, 'meta', '')
  const n = run.dropped + run.reported
  run.droppedLine.textContent = `… ${n} more line${n === 1 ? '' : 's'} dropped`
}

// the socket answers in order, also after a run has ended: those answers are dropped here
const answer = (run, message, transfer = []) => { if (current === run) run.worker.postMessage(message, transfer) }

// js-runner.js never sends a request that breaks these rules (it checks the size itself and
// queues requests beyond MAX_PENDING): code that bypasses it has its run ended
function evaluateFor(run, { id, bytes }) {
  if (!Number.isSafeInteger(id) || !(bytes instanceof Uint8Array)) return abort(run, 'The run sent a malformed request: ended.')
  if (bytes.length > MAX_REQUEST) return abort(run, `The run sent a request of more than ${MAX_REQUEST} bytes: ended.`)
  if (run.pending >= MAX_PENDING) return abort(run, `The run sent more than ${MAX_PENDING} requests at once: ended.`)
  run.pending++
  run.held.push({ id, bytes })
  sendHeld(run)
}

// Sends a run's requests while fewer than MAX_PENDING of all runs are in the kernel: those of a
// stopped run still are, and wait their turn there; a run's requests that were not sent yet are
// dropped with it, so repeated Run and Stop cannot pile up work in the kernel.
function sendHeld(run) {
  while (current === run && run.held.length && inKernel < MAX_PENDING) {
    const { id, bytes } = run.held.shift()
    inKernel++
    run.sent++
    run.evaluations++
    socket.evaluateWXF(bytes).then(reply => {
      if (Number.isFinite(reply.timing)) run.kernel += reply.timing
      if (current === run) keep(run, id, displayOf(reply))
      done(run)
      answer(run, { type: 'reply', id, bytes: reply.bytes }, [reply.bytes.buffer])
    }, err => {
      done(run)
      answer(run, { type: 'reply', id, error: err.message })
    })
  }
  const earlier = inKernel - run.sent
  if (current === run) {
    run.meta.textContent = run.held.length && earlier > 0
      ? `Running… (waiting for ${earlier} evaluation${earlier === 1 ? '' : 's'} of earlier runs)` : 'Running…'
  }
}

function done(run) {
  inKernel--
  run.sent--
  run.pending--
  if (current) sendHeld(current)
}

// the displays of a run's replies, newest last: at most KEEP, and KEEP_BYTES beyond the newest ones
function keep(run, id, display) {
  const size = display.success
    ? (display.image?.data.length || 0) + (display.tex?.length || 0) + display.inputForm.length + display.messages.join('').length : 0
  run.replies.delete(id)
  run.replies.set(id, { display, size })
  run.keptBytes += size
  for (const [old, { size }] of run.replies) {
    if (run.replies.size <= KEEP && (run.keptBytes <= KEEP_BYTES || run.replies.size <= KEEP_NEWEST)) break
    run.replies.delete(old)
    run.keptBytes -= size
  }
}

function renderFor(run, { id, of, label }) {
  if (!Number.isSafeInteger(id)) return
  const kept = run.replies.get(of)
  answer(run, { type: 'rendered', id, ok: !!kept })
  if (!kept) return
  if (run.shown >= MAX_SHOWN) {
    if (run.shown++ === MAX_SHOWN) line(run.output, 'meta', `… further results not shown (at most ${MAX_SHOWN} in a run)`)
    return
  }
  run.shown++
  const box = document.createElement('div')
  box.className = 'shown'
  run.output.append(box)
  renderReply(box, run.owner, kept.display, typeof label === 'string' ? clip(label, 300) : 'result')
}

function finish(run, state) {
  if (current !== run) return
  current = null
  run.worker.terminate()
  // messages already queued are still delivered after terminate(): not to this run
  run.worker.onmessage = run.worker.onerror = null
  run.held = []   // never sent
  run.replies.clear()
  run.owner.dataset.state = state
  const n = run.evaluations
  run.meta.textContent = [state === 'stopped' ? 'Stopped' : '', `${n} kernel evaluation${n === 1 ? '' : 's'}`,
    `${run.kernel.toFixed(4)} s in the kernel`, `${Math.round(performance.now() - run.start)} ms in all`].filter(Boolean).join(' · ')
  run.ended(state)
}

// ---- code in links ----
// The examples page opens code in the test page's JavaScript mode with index.html#js=<code>: the
// fragment is never sent to the server, and the code is only put in the editor, never run.

export const MAX_LINK_CODE = 20000   // characters of code taken from a link

/** A link to the test page (with this page's query: token, wasm) that opens code in its JavaScript mode */
export const editorLink = code => `index.html${location.search}#js=${encodeURIComponent(code)}`

/** The code of a #js=... fragment: { code }, { error } for a malformed or too long one, null for none */
export function codeOfFragment(hash) {
  if (!hash.startsWith('#js=')) return null
  const encoded = hash.slice(4)
  // a character takes at most 9 characters encoded (%XX%XX%XX); longer ones are not decoded at all
  if (encoded.length > 9 * MAX_LINK_CODE) return { error: `The code in the link is too long (at most ${MAX_LINK_CODE} characters): not loaded.` }
  let code
  try { code = decodeURIComponent(encoded) } catch { return { error: 'The code in the link is malformed: not loaded.' } }
  if (code.length > MAX_LINK_CODE) return { error: `The code in the link is too long (${code.length} characters, at most ${MAX_LINK_CODE}): not loaded.` }
  return { code }
}
