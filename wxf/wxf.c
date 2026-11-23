/* WXF encoder and decoder; see wxf.h. No libc: memory comes from the caller's callback. */
#include "wxf.h"

static void copy_bytes(uint8_t *dst, const uint8_t *src, size_t n) {
    while (n--) *dst++ = *src++;
}

size_t wxf_array_element_size(int type) {
    switch (type) {
    case WXF_ARRAY_INT8: case WXF_ARRAY_UINT8: return 1;
    case WXF_ARRAY_INT16: case WXF_ARRAY_UINT16: return 2;
    case WXF_ARRAY_INT32: case WXF_ARRAY_UINT32: case WXF_ARRAY_REAL32: return 4;
    case WXF_ARRAY_INT64: case WXF_ARRAY_UINT64: case WXF_ARRAY_REAL64: case WXF_ARRAY_COMPLEX64: return 8;
    case WXF_ARRAY_COMPLEX128: return 16;
    default: return 0;
    }
}

static int packed_type(int type) {
    return type == WXF_ARRAY_INT8 || type == WXF_ARRAY_INT16 || type == WXF_ARRAY_INT32 ||
           type == WXF_ARRAY_INT64 || type == WXF_ARRAY_REAL32 || type == WXF_ARRAY_REAL64 ||
           type == WXF_ARRAY_COMPLEX64 || type == WXF_ARRAY_COMPLEX128;
}

/* ---- writer ---- */

static int reserve(wxf_writer *w, size_t extra) {
    if (w->error) return w->error;
    if (extra > SIZE_MAX - w->length) return w->error = WXF_ERR_NOMEM;
    size_t need = w->length + extra;
    if (need <= w->capacity) return WXF_OK;
    size_t cap = w->capacity ? w->capacity : 64;
    while (cap < need) {
        if (cap > SIZE_MAX / 2) { cap = need; break; }
        cap *= 2;
    }
    uint8_t *p = w->realloc_fn(w->ctx, w->data, w->capacity, cap);
    if (!p) return w->error = WXF_ERR_NOMEM;
    w->data = p;
    w->capacity = cap;
    return WXF_OK;
}

static int put_raw(wxf_writer *w, const void *bytes, size_t n) {
    int rc = reserve(w, n);
    if (rc != WXF_OK) return rc;
    copy_bytes(w->data + w->length, bytes, n);
    w->length += n;
    return WXF_OK;
}

static int put_byte(wxf_writer *w, uint8_t b) { return put_raw(w, &b, 1); }

static int put_varint(wxf_writer *w, uint64_t v) {
    uint8_t buf[10];
    size_t n = 0;
    do {
        uint8_t b = v & 0x7F;
        v >>= 7;
        buf[n++] = b | (v ? 0x80 : 0);
    } while (v);
    return put_raw(w, buf, n);
}

static int put_le(wxf_writer *w, uint64_t v, size_t n) {
    uint8_t buf[8];
    for (size_t i = 0; i < n; i++) buf[i] = (uint8_t)(v >> (8 * i));
    return put_raw(w, buf, n);
}

static int put_counted(wxf_writer *w, uint8_t kind, const void *bytes, size_t n) {
    if (!bytes && n) return w->error ? w->error : (w->error = WXF_ERR_ARG);
    put_byte(w, kind);
    put_varint(w, n);
    return put_raw(w, bytes, n);
}

int wxf_writer_init(wxf_writer *w, wxf_realloc_fn realloc_fn, void *ctx) {
    w->data = 0;
    w->length = w->capacity = 0;
    w->error = 0;
    w->realloc_fn = realloc_fn;
    w->ctx = ctx;
    return put_raw(w, "8:", 2);
}

void wxf_writer_free(wxf_writer *w) {
    if (w->data) w->realloc_fn(w->ctx, w->data, w->capacity, 0);
    w->data = 0;
    w->length = w->capacity = 0;
}

int wxf_put_function(wxf_writer *w, uint64_t argc) {
    put_byte(w, WXF_FUNCTION);
    return put_varint(w, argc);
}

int wxf_put_symbol(wxf_writer *w, const char *name, size_t n) {
    if (!n) return w->error ? w->error : (w->error = WXF_ERR_ARG);
    return put_counted(w, WXF_SYMBOL, name, n);
}

int wxf_put_string(wxf_writer *w, const char *s, size_t n) { return put_counted(w, WXF_STRING, s, n); }

int wxf_put_binary(wxf_writer *w, const uint8_t *b, size_t n) { return put_counted(w, WXF_BINARY_STRING, b, n); }

int wxf_put_integer(wxf_writer *w, int64_t v) {
    if (v >= INT8_MIN && v <= INT8_MAX) { put_byte(w, WXF_INTEGER8); return put_le(w, (uint64_t)v, 1); }
    if (v >= INT16_MIN && v <= INT16_MAX) { put_byte(w, WXF_INTEGER16); return put_le(w, (uint64_t)v, 2); }
    if (v >= INT32_MIN && v <= INT32_MAX) { put_byte(w, WXF_INTEGER32); return put_le(w, (uint64_t)v, 4); }
    put_byte(w, WXF_INTEGER64);
    return put_le(w, (uint64_t)v, 8);
}

int wxf_put_big_integer(wxf_writer *w, const char *digits, size_t n) {
    size_t i = (n && digits[0] == '-') ? 1 : 0;
    if (i == n) return w->error ? w->error : (w->error = WXF_ERR_ARG);
    for (; i < n; i++)
        if (digits[i] < '0' || digits[i] > '9') return w->error ? w->error : (w->error = WXF_ERR_ARG);
    return put_counted(w, WXF_BIG_INTEGER, digits, n);
}

int wxf_put_real(wxf_writer *w, double v) {
    union { double d; uint64_t u; } bits;
    bits.d = v;
    put_byte(w, WXF_REAL64);
    return put_le(w, bits.u, 8);
}

int wxf_put_big_real(wxf_writer *w, const char *text, size_t n) {
    if (!n) return w->error ? w->error : (w->error = WXF_ERR_ARG);
    return put_counted(w, WXF_BIG_REAL, text, n);
}

int wxf_put_association(wxf_writer *w, uint64_t count) {
    put_byte(w, WXF_ASSOCIATION);
    return put_varint(w, count);
}

int wxf_put_rule(wxf_writer *w) { return put_byte(w, WXF_RULE); }

int wxf_put_rule_delayed(wxf_writer *w) { return put_byte(w, WXF_RULE_DELAYED); }

int wxf_put_array(wxf_writer *w, int numeric, int type, size_t rank, const uint64_t *dims, const void *data) {
    size_t elem = wxf_array_element_size(type);
    if (w->error) return w->error;
    if (!elem || (!numeric && !packed_type(type)) || rank < 1 || rank > WXF_MAX_RANK || !dims)
        return w->error = WXF_ERR_ARG;
    uint64_t total = elem;
    for (size_t i = 0; i < rank; i++) {
        if (dims[i] && total > WXF_MAX_ARRAY_BYTES / dims[i]) return w->error = WXF_ERR_ARG;
        total *= dims[i];
    }
    if (total > SIZE_MAX || (total && !data)) return w->error = WXF_ERR_ARG;
    put_byte(w, numeric ? WXF_NUMERIC_ARRAY : WXF_PACKED_ARRAY);
    put_byte(w, (uint8_t)type);
    put_varint(w, rank);
    for (size_t i = 0; i < rank; i++) put_varint(w, dims[i]);
    return put_raw(w, data, (size_t)total);
}

/* ---- reader ---- */

int wxf_reader_init(wxf_reader *r, const uint8_t *data, size_t n) {
    r->pos = r->end = data;
    if (n >= 3 && data[0] == '8' && data[1] == 'C' && data[2] == ':') return WXF_ERR_COMPRESSED;
    if (n < 2 || data[0] != '8' || data[1] != ':') return WXF_ERR_HEADER;
    r->pos = data + 2;
    r->end = data + n;
    return WXF_OK;
}

static int get_varint(wxf_reader *r, uint64_t *out) {
    uint64_t v = 0;
    for (int shift = 0; shift < 64; shift += 7) {
        if (r->pos >= r->end) return WXF_ERR_TRUNCATED;
        uint8_t b = *r->pos++;
        if (shift == 63 && (b & 0x7E)) return WXF_ERR_VARINT;
        v |= (uint64_t)(b & 0x7F) << shift;
        if (!(b & 0x80)) { *out = v; return WXF_OK; }
    }
    return WXF_ERR_VARINT;
}

static int get_bytes(wxf_reader *r, uint64_t n, wxf_token *t) {
    if (n > (uint64_t)(r->end - r->pos)) return WXF_ERR_TRUNCATED;
    t->bytes = r->pos;
    t->size = (size_t)n;
    r->pos += n;
    return WXF_OK;
}

static uint64_t get_le(const uint8_t *p, size_t n) {
    uint64_t v = 0;
    for (size_t i = 0; i < n; i++) v |= (uint64_t)p[i] << (8 * i);
    return v;
}

int wxf_next(wxf_reader *r, wxf_token *t) {
    uint64_t n;
    int rc;
    if (r->pos >= r->end) return WXF_END;
    t->kind = *r->pos++;
    t->bytes = 0;
    t->size = 0;
    switch (t->kind) {
    case WXF_FUNCTION:
    case WXF_ASSOCIATION:
        return get_varint(r, &t->count);
    case WXF_SYMBOL:
    case WXF_STRING:
    case WXF_BINARY_STRING:
    case WXF_BIG_INTEGER:
    case WXF_BIG_REAL:
        if ((rc = get_varint(r, &n)) != WXF_OK) return rc;
        return get_bytes(r, n, t);
    case WXF_INTEGER8: case WXF_INTEGER16: case WXF_INTEGER32: case WXF_INTEGER64: {
        size_t size = t->kind == WXF_INTEGER8 ? 1 : t->kind == WXF_INTEGER16 ? 2 : t->kind == WXF_INTEGER32 ? 4 : 8;
        if ((size_t)(r->end - r->pos) < size) return WXF_ERR_TRUNCATED;
        uint64_t u = get_le(r->pos, size);
        r->pos += size;
        if (size < 8 && (u >> (8 * size - 1)) & 1) u |= ~(uint64_t)0 << (8 * size); /* sign extend */
        t->integer = (int64_t)u;
        return WXF_OK;
    }
    case WXF_REAL64: {
        union { double d; uint64_t u; } bits;
        if (r->end - r->pos < 8) return WXF_ERR_TRUNCATED;
        bits.u = get_le(r->pos, 8);
        r->pos += 8;
        t->real = bits.d;
        return WXF_OK;
    }
    case WXF_RULE:
    case WXF_RULE_DELAYED:
        return WXF_OK;
    case WXF_PACKED_ARRAY:
    case WXF_NUMERIC_ARRAY: {
        if (r->pos >= r->end) return WXF_ERR_TRUNCATED;
        t->array_type = *r->pos++;
        size_t elem = wxf_array_element_size(t->array_type);
        if (!elem || (t->kind == WXF_PACKED_ARRAY && !packed_type(t->array_type))) return WXF_ERR_ARRAY;
        if ((rc = get_varint(r, &n)) != WXF_OK) return rc;
        if (n < 1 || n > WXF_MAX_RANK) return WXF_ERR_ARRAY;
        t->rank = (size_t)n;
        uint64_t total = elem;
        for (size_t i = 0; i < t->rank; i++) {
            if ((rc = get_varint(r, &t->dims[i])) != WXF_OK) return rc;
            if (t->dims[i] && total > WXF_MAX_ARRAY_BYTES / t->dims[i]) return WXF_ERR_ARRAY;
            total *= t->dims[i];
        }
        return get_bytes(r, total, t);
    }
    default:
        return WXF_ERR_TOKEN;
    }
}
