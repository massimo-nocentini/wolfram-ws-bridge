// What the test page (index.html) and the examples page (examples.html) share: the connection,
// showing a reply (KaTeX, a picture or text, kernel messages, a meta line), and JavaScript runs in a
// worker (js-runner.js). One run at a time per page.
import { WXF, toInputForm } from './wxf.js'
import { WolframSocket, imageURL } from './wolfram-socket.js'

export const params = new URLSearchParams(location.search)
export const token = params.get('token') || ''
export const wasmFile = 'wxf.wasm'
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
    status(`Connected to ${location.host}.`)
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
// trust: false: no \href or \url; \arraystretch spaces the rows of matrices of fractions.
const KATEX = { displayMode: true, fleqn: true, throwOnError: false, strict: 'ignore', trust: false, maxExpand: Infinity }
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
// show(). The "decoded:" text is only a preview; the full InputForm is shown above it.
export function displayOf(reply) {
  if (!reply.success) return { success: false, failure: reply.failure, message: reply.message, symbols: reply.symbols }
  let detail
  if (reply.image) detail = `${reply.image.format} picture, ${(reply.image.data.length / 1024).toFixed(1)} KB`
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
// the wasm module. Its messages are checked for their types only, text is shown only as text, and
// only replies that the page itself got from the kernel for the run are shown (the worker names
// them by id). There are no limits on what a run prints, shows or sends.

const IN_KERNEL = 8                   // requests of all runs sent to the server at once: the others wait their turn here
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
  const run = { worker, owner, output, meta, ended, start: performance.now(), evaluations: 0, kernel: 0, sent: 0, held: [],
                replies: new Map(), finished: new Set() }
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

function receive(run, m) {
  if (current !== run || m === null || typeof m !== 'object' || typeof m.type !== 'string') return
  switch (m.type) {
    case 'eval': return evaluateFor(run, m)
    case 'render': return renderFor(run, m)
    case 'console':
      if (typeof m.text === 'string') line(run.output, m.level === 'warn' || m.level === 'error' ? 'msg' : 'out', m.text)
      return
    case 'result': case 'error':   // once each, at the end of the run
      if (typeof m.text !== 'string' || run.finished.has(m.type)) return
      run.finished.add(m.type)
      line(run.output, m.type === 'error' ? 'out err' : 'out result', m.text)
      return
    case 'done': return finish(run, 'done')
  }
}

const abort = (run, reason) => { line(run.output, 'out err', reason); finish(run, 'failed') }

// the socket answers in order, also after a run has ended: those answers are dropped here
const answer = (run, message, transfer = []) => { if (current === run) run.worker.postMessage(message, transfer) }

function evaluateFor(run, { id, bytes }) {
  if (!Number.isSafeInteger(id) || !(bytes instanceof Uint8Array)) return abort(run, 'The run sent a malformed request: ended.')
  run.held.push({ id, bytes })
  sendHeld(run)
}

// Sends a run's requests while fewer than IN_KERNEL of all runs are in the kernel: those of a
// stopped run still are, and wait their turn there; a run's requests that were not sent yet are
// dropped with it, so repeated Run and Stop cannot pile up work in the kernel.
function sendHeld(run) {
  while (current === run && run.held.length && inKernel < IN_KERNEL) {
    const { id, bytes } = run.held.shift()
    inKernel++
    run.sent++
    run.evaluations++
    socket.evaluateWXF(bytes).then(reply => {
      if (Number.isFinite(reply.timing)) run.kernel += reply.timing
      if (current === run) run.replies.set(id, displayOf(reply))
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
  if (current) sendHeld(current)
}

function renderFor(run, { id, of, label }) {
  if (!Number.isSafeInteger(id)) return
  const display = run.replies.get(of)
  answer(run, { type: 'rendered', id, ok: !!display })
  if (!display) return
  const box = document.createElement('div')
  box.className = 'shown'
  run.output.append(box)
  renderReply(box, run.owner, display, typeof label === 'string' ? label : 'result')
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

/** A link to the test page (with this page's query: token, wasm) that opens code in its JavaScript mode */
export const editorLink = code => `index.html${location.search}#js=${encodeURIComponent(code)}`

/** The code of a #js=... fragment: { code }, { error } for a malformed one, null for none */
export function codeOfFragment(hash) {
  if (!hash.startsWith('#js=')) return null
  try { return { code: decodeURIComponent(hash.slice(4)) } } catch { return { error: 'The code in the link is malformed: not loaded.' } }
}
