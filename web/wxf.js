// Wolfram expressions <-> WXF bytes, using wxf.wasm (wasm32) or wxf64.wasm (wasm64, memory64).
// Works in browsers and in Node (ES module).
//
// JavaScript form of expressions:
//   integers           number (or BigInt beyond 2^53)       reals         WReal (or a non-integer number when encoding)
//   strings            string                               symbols       WSymbol, e.g. sym("Pi"), sym("Global`x")
//   List[...]          Array                                f[args]       WFunction, e.g. fn("Integrate", x, x)
//   Association        WAssociation (plain objects encode as associations with string keys)
//   ByteArray          Uint8Array                           packed and numeric arrays   WArray
//   arbitrary-precision reals   WBigReal("3.14159`20.")     True/False/Null   true/false/null when encoding

export class WSymbol {
  constructor(name) { this.name = name }
}
export class WFunction {
  constructor(head, args) { this.head = head; this.args = args }
}
export class WReal {
  constructor(value) { this.value = value }
}
export class WBigReal {
  constructor(text) { this.text = text }
}
export class WAssociation {
  /** entries: [key, value, delayed] triples, in order */
  constructor(entries = []) { this.entries = entries }
  get(key) {
    const entry = this.entries.find(([k]) => k === key)
    return entry && entry[1]
  }
  /** plain object of the entries whose keys are strings */
  toObject() {
    const out = {}
    for (const [k, v] of this.entries) if (typeof k === 'string') out[k] = v
    return out
  }
}

const ARRAY_TYPES = {
  0: ['Integer8', Int8Array], 1: ['Integer16', Int16Array], 2: ['Integer32', Int32Array], 3: ['Integer64', BigInt64Array],
  16: ['UnsignedInteger8', Uint8Array], 17: ['UnsignedInteger16', Uint16Array], 18: ['UnsignedInteger32', Uint32Array],
  19: ['UnsignedInteger64', BigUint64Array], 34: ['Real32', Float32Array], 35: ['Real64', Float64Array],
  51: ['ComplexReal32', Float32Array], 52: ['ComplexReal64', Float64Array],
}
const TYPE_CODES = Object.fromEntries(Object.entries(ARRAY_TYPES).map(([code, [name]]) => [name, Number(code)]))

export class WArray {
  /**
   * numeric: false for a packed array, true for a NumericArray. type: e.g. "Real64".
   * dims: dimensions. data: typed array in row-major order (complex types as re, im pairs).
   */
  constructor(numeric, type, dims, data) {
    if (!(type in TYPE_CODES)) throw new TypeError(`unknown array type ${type}`)
    this.numeric = numeric; this.type = type; this.dims = dims; this.data = data
  }
  /** nested JavaScript arrays; complex elements become [re, im] */
  toNested() {
    const complex = this.type.startsWith('Complex')
    let i = 0
    const build = level => Array.from({ length: this.dims[level] }, () => {
      if (level < this.dims.length - 1) return build(level + 1)
      if (complex) { const v = [this.data[i], this.data[i + 1]]; i += 2; return v }
      return this.data[i++]
    })
    return build(0)
  }
}

export const sym = name => new WSymbol(name)
export const fn = (head, ...args) => new WFunction(typeof head === 'string' ? new WSymbol(head) : head, args)
export const real = value => new WReal(value)

const ERRORS = {
  [-1]: 'input ends inside an expression', [-2]: 'not WXF (missing 8: header)', [-3]: 'compressed WXF is not supported',
  [-4]: 'unknown token', [-5]: 'malformed length', [-6]: 'bad array', [-7]: 'out of memory', [-8]: 'invalid value',
}
export class WXFError extends Error {
  constructor(code, detail) {
    super(`WXF error ${code}: ${detail || ERRORS[code] || 'unknown'}`)
    this.code = code
  }
}

const INT64_MIN = -(2n ** 63n), INT64_MAX = 2n ** 63n - 1n
const K = { f: 0x66, s: 0x73, S: 0x53, B: 0x42, C: 0x43, j: 0x6a, i: 0x69, L: 0x4c, r: 0x72, I: 0x49, R: 0x52, A: 0x41, rule: 0x2d, delayed: 0x3a, packed: 0xc1, numeric: 0xc2 }

// Exports whose arguments or results are pointers or sizes: i32 on wasm32, i64 (BigInt) on wasm64.
// [positions of such arguments, whether the result is one]
const SIZE_SIGNATURES = {
  wxf_alloc: [[0], true], wxf_scratch: [[0], true],
  wxf_w_symbol: [[0, 1]], wxf_w_string: [[0, 1]], wxf_w_binary: [[0, 1]], wxf_w_big_integer: [[0, 1]],
  wxf_w_big_real: [[0, 1]], wxf_w_array: [[2, 3, 4]], wxf_w_data: [[], true], wxf_w_length: [[], true],
  wxf_r_begin: [[0, 1]], wxf_r_bytes: [[], true], wxf_r_size: [[], true], wxf_r_rank: [[], true], wxf_r_dim: [[0]],
}

/** The module's exports with every pointer and size as a plain number, for both wasm32 and wasm64. */
function adapt(exports) {
  const wasm64 = exports.wxf_pointer_size() === 8
  const out = { memory: exports.memory, wasm64 }
  for (const [name, f] of Object.entries(exports)) {
    if (typeof f !== 'function') continue
    const signature = SIZE_SIGNATURES[name]
    if (!signature) { out[name] = f; continue }
    const [positions, sizeResult] = signature
    out[name] = (...args) => {
      if (wasm64) for (const i of positions) args[i] = BigInt(args[i])
      const result = f(...args)
      // wasm32 returns i32 as a signed number: >>> 0 keeps addresses above 2 GiB positive
      return sizeResult ? (wasm64 ? Number(result) : result >>> 0) : result
    }
  }
  return out
}

export class WXF {
  /**
   * source: URL of wxf.wasm (the default) or wxf64.wasm, a fetch Response, or the module bytes.
   * wxf64.wasm needs memory64 support (Chrome/Edge 133+, Firefox 134+, Node 24+).
   */
  static async load(source = new URL('./wxf.wasm', import.meta.url)) {
    let bytes
    if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) bytes = source
    else {
      const response = source instanceof Response ? source : await fetch(source)
      if (!response.ok) throw new Error(`cannot load ${response.url}: ${response.status}`)
      bytes = await response.arrayBuffer()
    }
    const { instance } = await WebAssembly.instantiate(bytes)
    return new WXF(instance.exports)
  }

  constructor(exports) {
    this.x = adapt(exports)
    /** true when the loaded module is wasm64 */
    this.wasm64 = this.x.wasm64
    this.encoder = new TextEncoder()
    this.decoder = new TextDecoder('utf-8')
  }

  // the memory can grow during a call, which detaches older views: always take a fresh one
  get #mem() { return new Uint8Array(this.x.memory.buffer) }

  /** expression -> Uint8Array of WXF */
  encode(expr) {
    const x = this.x
    x.wxf_reset()
    this.#check(x.wxf_w_begin())
    this.#put(expr)
    const err = x.wxf_w_error()
    if (err) throw new WXFError(err)
    const p = x.wxf_w_data()
    return this.#mem.slice(p, p + x.wxf_w_length())
  }

  /** Uint8Array or ArrayBuffer of WXF -> expression */
  decode(bytes) {
    const x = this.x
    const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    x.wxf_reset()
    const p = x.wxf_alloc(input.length)
    this.#mem.set(input, p)
    this.#check(x.wxf_r_begin(p, input.length))
    const value = this.#read()
    const rc = x.wxf_r_next()
    if (rc !== 0) throw new WXFError(rc < 0 ? rc : -4, rc < 0 ? undefined : 'data after the expression')
    return value
  }

  #check(rc) { if (rc < 0) throw new WXFError(rc) }

  #text(fnName, text) {
    const bytes = this.encoder.encode(text)
    const p = this.x.wxf_scratch(bytes.length)
    this.#mem.set(bytes, p)
    this.#check(this.x[fnName](p, bytes.length))
  }

  #put(e) {
    const x = this.x
    if (typeof e === 'number') {
      if (!Number.isFinite(e)) throw new WXFError(-8, `cannot encode ${e}`)
      if (Number.isInteger(e)) return this.#put(BigInt(e))
      return this.#check(x.wxf_w_real(e))
    }
    if (typeof e === 'bigint') {
      if (e >= INT64_MIN && e <= INT64_MAX) return this.#check(x.wxf_w_integer(e))
      return this.#text('wxf_w_big_integer', e.toString())
    }
    if (typeof e === 'string') return this.#text('wxf_w_string', e)
    if (typeof e === 'boolean') return this.#text('wxf_w_symbol', e ? 'True' : 'False')
    if (e === null || e === undefined) return this.#text('wxf_w_symbol', 'Null')
    if (e instanceof WSymbol) return this.#text('wxf_w_symbol', e.name)
    if (e instanceof WReal) {
      if (!Number.isFinite(e.value)) throw new WXFError(-8, `cannot encode ${e.value}`)
      return this.#check(x.wxf_w_real(e.value))
    }
    if (e instanceof WBigReal) return this.#text('wxf_w_big_real', e.text)
    if (e instanceof Uint8Array) {
      const p = x.wxf_alloc(e.length)
      this.#mem.set(e, p)
      return this.#check(x.wxf_w_binary(p, e.length))
    }
    if (Array.isArray(e)) {
      this.#check(x.wxf_w_function(e.length))
      this.#text('wxf_w_symbol', 'List')
      for (const item of e) this.#put(item)
      return
    }
    if (e instanceof WFunction) {
      this.#check(x.wxf_w_function(e.args.length))
      this.#put(e.head)
      for (const arg of e.args) this.#put(arg)
      return
    }
    if (e instanceof WArray) return this.#putArray(e)
    const entries = e instanceof WAssociation ? e.entries
      : e instanceof Map ? [...e].map(([k, v]) => [k, v, false])
      : Object.getPrototypeOf(e) === Object.prototype ? Object.entries(e).map(([k, v]) => [k, v, false])
      : null
    if (!entries) throw new TypeError(`cannot encode ${Object.prototype.toString.call(e)} as WXF`)
    this.#check(x.wxf_w_association(entries.length))
    for (const [k, v, delayed] of entries) {
      this.#check(delayed ? x.wxf_w_rule_delayed() : x.wxf_w_rule())
      this.#put(k)
      this.#put(v)
    }
  }

  #putArray(a) {
    const x = this.x
    const dims = x.wxf_alloc(4 * a.dims.length)
    new Uint32Array(x.memory.buffer, dims, a.dims.length).set(a.dims)
    const bytes = new Uint8Array(a.data.buffer, a.data.byteOffset, a.data.byteLength)
    const data = x.wxf_alloc(bytes.length)
    this.#mem.set(bytes, data)
    this.#check(x.wxf_w_array(a.numeric ? 1 : 0, TYPE_CODES[a.type], a.dims.length, dims, data))
  }

  #bytes() {
    const p = this.x.wxf_r_bytes()
    return this.#mem.slice(p, p + this.x.wxf_r_size())
  }

  #read() {
    const x = this.x
    const rc = x.wxf_r_next()
    if (rc !== 1) throw new WXFError(rc === 0 ? -1 : rc)
    switch (x.wxf_r_kind()) {
      case K.f: {
        const n = x.wxf_r_count()
        const head = this.#read()
        const args = []
        for (let i = 0; i < n; i++) args.push(this.#read())
        return head instanceof WSymbol && head.name === 'List' ? args : new WFunction(head, args)
      }
      case K.s: return new WSymbol(this.decoder.decode(this.#bytes()))
      case K.S: return this.decoder.decode(this.#bytes())
      case K.B: return this.#bytes()
      case K.C: case K.j: case K.i: case K.L: {
        const v = x.wxf_r_integer()
        return v >= -(2n ** 53n) && v <= 2n ** 53n ? Number(v) : v
      }
      case K.I: return BigInt(this.decoder.decode(this.#bytes()))
      case K.r: return new WReal(x.wxf_r_real())
      case K.R: return new WBigReal(this.decoder.decode(this.#bytes()))
      case K.A: {
        const n = x.wxf_r_count()
        const entries = []
        for (let i = 0; i < n; i++) {
          const rule = x.wxf_r_next()
          if (rule !== 1) throw new WXFError(rule === 0 ? -1 : rule)
          const kind = x.wxf_r_kind()
          if (kind !== K.rule && kind !== K.delayed) throw new WXFError(-4, 'association entry without a rule')
          const key = this.#read()
          entries.push([key, this.#read(), kind === K.delayed])
        }
        return new WAssociation(entries)
      }
      case K.packed: case K.numeric: {
        const [type, Ctor] = ARRAY_TYPES[x.wxf_r_array_type()]
        const dims = Array.from({ length: x.wxf_r_rank() }, (_, i) => x.wxf_r_dim(i))
        const bytes = this.#bytes()
        return new WArray(x.wxf_r_kind() === K.numeric, type, dims, new Ctor(bytes.buffer, 0, bytes.length / Ctor.BYTES_PER_ELEMENT))
      }
      default:
        throw new WXFError(-4)
    }
  }
}

/** Wolfram Language text for an expression, close to InputForm (for display only). */
export function toInputForm(e) {
  if (typeof e === 'number' || typeof e === 'bigint') return String(e)
  if (typeof e === 'string') return JSON.stringify(e)
  if (typeof e === 'boolean') return e ? 'True' : 'False'
  if (e === null || e === undefined) return 'Null'
  if (e instanceof WSymbol) return e.name.replace(/^(System|Global)`/, '')
  if (e instanceof WReal) return formatReal(e.value)
  if (e instanceof WBigReal) return e.text
  if (e instanceof Uint8Array) return `ByteArray[{${e.join(', ')}}]`
  if (Array.isArray(e)) return `{${e.map(toInputForm).join(', ')}}`
  if (e instanceof WArray) {
    const list = toInputForm(e.toNested().map(function nest(v) {
      return Array.isArray(v) && Array.isArray(v[0]) ? v.map(nest) : v
    }))
    return e.numeric ? `NumericArray[${list}, "${e.type}"]` : list
  }
  if (e instanceof WAssociation) {
    return `<|${e.entries.map(([k, v, d]) => `${toInputForm(k)} ${d ? ':>' : '->'} ${toInputForm(v)}`).join(', ')}|>`
  }
  if (e instanceof WFunction) {
    const head = e.head instanceof WSymbol ? e.head.name : null
    if ((head === 'Rule' || head === 'RuleDelayed') && e.args.length === 2) {
      return `${toInputForm(e.args[0])} ${head === 'Rule' ? '->' : ':>'} ${toInputForm(e.args[1])}`
    }
    return `${toInputForm(e.head)}[${e.args.map(toInputForm).join(', ')}]`
  }
  return String(e)
}

function formatReal(v) {
  if (Number.isInteger(v) && Math.abs(v) < 1e21) return `${v}.`
  const [mantissa, exponent] = v.toString().split('e')
  if (exponent === undefined) return mantissa
  return `${mantissa}${mantissa.includes('.') ? '' : '.'}*^${exponent.replace('+', '')}`
}
