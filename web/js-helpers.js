// Helpers for JavaScript code that talks to the bridge: W for building expressions, Wolfram
// Language text from templates, plain JavaScript from results, display text for any value.
// Pure (no wasm, no I/O), so Node imports it as well as the test page's worker (js-runner.js).
import { WArray, WAssociation, WBigReal, WFunction, WReal, WSymbol, fn, real, sym, toInputForm } from './wxf.js'

export { WArray, WAssociation, WBigReal, WFunction, WReal, WSymbol, fn, real, sym, toInputForm }

/**
 * A symbol that is also callable as a head: callableSymbol('f') is the symbol f, and
 * callableSymbol('f')(1, x) is f[1, x] (the same expression as fn('f', 1, x)). It is a function
 * whose prototype is WSymbol.prototype, so instanceof WSymbol, the WXF encoder and toInputForm
 * take it as a symbol.
 */
export function callableSymbol(name) {
  const head = new WSymbol(name)
  const symbol = (...args) => new WFunction(head, args)
  Object.setPrototypeOf(symbol, WSymbol.prototype)
  // a function's own `name` is read-only: redefine it to the symbol's name
  Object.defineProperty(symbol, 'name', { value: name, enumerable: true })
  return symbol
}

// WXF reads a symbol name without a context as a System` symbol, and the kernel makes one that it
// does not have. So a name that starts with a capital letter or $
// (Sin, Pi, C, $MachinePrecision) stays a System` name, and any other name (x, f, myVar) is a
// variable in Global`. For a capitalized variable write W['Global`A']: W.A is System`A, which is
// another symbol than the A typed before, and the one that A typed afterwards means.
export const qualifiedName = name => name.includes('`') || /^[A-Z$]/.test(name) ? name : `Global\`${name}`

/**
 * W.x is the variable x (Global`x), W.Sin(W.x) is Sin[x], W.f(1) is f[1], W['Global`A'] is
 * Global`A (a variable with a capital letter: W.A is System`A, see qualifiedName). `then` is left out so
 * that W can pass through promises (await, async returns) without being called; use sym('then').
 */
export const W = new Proxy(Object.freeze(Object.create(null)), {
  get: (_, key) => typeof key === 'string' && key !== 'then' ? callableSymbol(qualifiedName(key)) : undefined,
})

const WOLFRAM_TYPES = [WSymbol, WFunction, WReal, WBigReal, WAssociation, WArray]

/** Whether v is a Wolfram expression (not a plain JS value), or an array holding one at any depth. */
export function isWolframValue(v, seen = new Set()) {
  if (WOLFRAM_TYPES.some(T => v instanceof T)) return true
  if (!Array.isArray(v) || seen.has(v)) return false
  seen.add(v)
  return v.some(item => isWolframValue(item, seen))
}

/** Whether a call's arguments are those of a tagged template: f`...` */
export const isTemplateCall = args => Array.isArray(args[0]) && Array.isArray(args[0].raw)

/**
 * Wolfram Language text of a tagged template: the raw strings (so \[Pi] stays as written) with
 * each value inserted as (InputForm), e.g. wlText`Solve[${p} == 0, x]`.
 */
export function wlText(strings, ...values) {
  let text = strings.raw[0]
  values.forEach((v, i) => {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new TypeError(`cannot insert ${v} into Wolfram Language text`)
    if (typeof v === 'function' && !(v instanceof WSymbol)) throw new TypeError('cannot insert a function into Wolfram Language text')
    if (typeof v === 'symbol') throw new TypeError('cannot insert a JavaScript symbol into Wolfram Language text')
    text += `(${toInputForm(v)})${strings.raw[i + 1]}`
  })
  return text
}

/** The request of a call made as f(expr) or as the tagged template f`...` */
export const requestOf = args => isTemplateCall(args) ? wlText(...args) : args[0]

/**
 * A decoded result as plain JavaScript: reals as numbers, True/False/Null as true/false/null,
 * associations as objects (a Map when a key is not a string), packed and numeric arrays as nested
 * arrays, lists element by element. Other expressions are returned unchanged.
 */
export function toJS(e) {
  if (e instanceof WReal) return e.value
  if (e instanceof WSymbol) {
    const name = e.name.replace(/^System`/, '')
    return name === 'True' ? true : name === 'False' ? false : name === 'Null' ? null : e
  }
  if (Array.isArray(e)) return e.map(toJS)
  if (e instanceof WArray) return e.toNested()
  if (e instanceof WAssociation) {
    const entries = e.entries.map(([k, v]) => [toJS(k), toJS(v)])
    // fromEntries defines properties, so a "__proto__" key stays a key
    return entries.every(([k]) => typeof k === 'string') ? Object.fromEntries(entries) : new Map(entries)
  }
  return e
}

const FULL = Symbol('full')

// a list that InputForm shows completely: expressions, numbers, strings, booleans, null, lists of
// them, 100 levels deep (so a cycle is not plain)
const plainList = (v, depth = 0) => depth < 100 && v.every(item => item === null ||
  ['number', 'bigint', 'string', 'boolean'].includes(typeof item) || WOLFRAM_TYPES.some(T => item instanceof T) ||
  (Array.isArray(item) && plainList(item, depth + 1)))

/**
 * Display text of any value, like console.log: strings as they are, Wolfram expressions as
 * InputForm, everything else JSON-like (BigInt as 5n, [Circular], [Function f]; objects more than 5 levels
 * deep as {…}). Never throws; with a limit, at most that many characters.
 */
export function formatValue(value, limit = Infinity) {
  if (typeof value === 'string') return value.length > limit ? `${value.slice(0, limit)}…` : value
  const parts = []
  let length = 0
  const put = s => { parts.push(s); length += s.length; if (length > limit) throw FULL }
  const ancestors = new Set()
  const write = (v, depth) => {
    if (typeof v === 'string') return put(JSON.stringify(v))
    if (typeof v === 'bigint') return put(`${v}n`)
    if (typeof v === 'number') return put(Object.is(v, -0) ? '-0' : String(v))
    if (typeof v === 'boolean' || v === undefined || v === null) return put(String(v))
    if (typeof v === 'symbol') return put(v.toString())
    if (WOLFRAM_TYPES.some(T => v instanceof T)) {
      let text
      // bounded by what is left of the limit, so that a huge result costs little
      try { text = toInputForm(v, limit - length + 1) } catch { text = '[Wolfram expression]' }   // e.g. a cycle in args
      return put(text)
    }
    if (Array.isArray(v) && isWolframValue(v) && plainList(v)) return put(toInputForm(v, limit - length + 1))   // {x -> 2}, not [x -> 2]
    if (typeof v === 'function') return put(`[Function${v.name ? ` ${v.name}` : ''}]`)
    if (ancestors.has(v)) return put('[Circular]')
    if (v instanceof Error) return put(`${v.name}: ${v.message}`)
    if (v instanceof Date) return put(Number.isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString())
    const typed = ArrayBuffer.isView(v) && !(v instanceof DataView)
    if (depth > 5 && !Array.isArray(v) && !typed) return put('{…}')
    ancestors.add(v)
    try {
      if (Array.isArray(v) || typed) {
        put(typed ? `${v.constructor.name}(${v.length}) [` : '[')
        for (let i = 0; i < v.length; i++) { if (i) put(', '); write(v[i], depth + 1) }
        return put(']')
      }
      if (v instanceof Map || v instanceof Set) {
        put(`${v instanceof Map ? 'Map' : 'Set'}(${v.size}) {`)
        let i = 0
        for (const item of v) {
          if (i++) put(', ')
          if (v instanceof Map) { write(item[0], depth + 1); put(' => '); write(item[1], depth + 1) } else write(item, depth + 1)
        }
        return put('}')
      }
      const name = Object.getPrototypeOf(v)?.constructor?.name
      put(name && name !== 'Object' ? `${name} {` : '{')
      const keys = Object.keys(v)
      keys.forEach((k, i) => {
        if (i) put(', ')
        put(/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k))
        put(': ')
        let item
        try { item = v[k] } catch { item = '[getter threw]' }
        write(item, depth + 1)
      })
      return put('}')
    } finally {
      ancestors.delete(v)
    }
  }
  try {
    write(value, 0)
  } catch (err) {
    if (err !== FULL) return parts.length ? `${parts.join('')} …` : '[value that cannot be shown]'
    return `${parts.join('').slice(0, limit)}…`
  }
  return parts.join('')
}
