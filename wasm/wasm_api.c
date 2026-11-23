/* wasm32 exports for wxf.c, used by web/wxf.js.
 *
 * Memory is a bump arena above __heap_base: wxf_reset() frees everything at once, so each
 * encode or decode starts with a reset. One writer and one reader exist at a time; JavaScript
 * reads results out of the exported memory before the next reset.
 */
#include "../wxf/wxf.h"

#define EXPORT(name) __attribute__((export_name(#name)))
#define PAGE 65536u

extern unsigned char __heap_base;
static uintptr_t heap_top;
static uint8_t *scratch;
static size_t scratch_size;
static wxf_writer writer;
static wxf_reader reader;
static wxf_token token;

static uintptr_t heap_start(void) { return ((uintptr_t)&__heap_base + 15) & ~(uintptr_t)15; }

static int ensure_memory(uintptr_t end) {
    size_t have = __builtin_wasm_memory_size(0) * PAGE;
    if (end <= have) return 1;
    size_t pages = (end - have + PAGE - 1) / PAGE;
    return __builtin_wasm_memory_grow(0, pages) != (size_t)-1;
}

static void *arena_alloc(size_t n) {
    if (!heap_top) heap_top = heap_start();
    uintptr_t p = (heap_top + 15) & ~(uintptr_t)15;
    if (n > UINTPTR_MAX - p || !ensure_memory(p + n)) return 0;
    heap_top = p + n;
    return (void *)p;
}

/* realloc callback for the writer: grows in place when the block is the newest one */
static void *arena_realloc(void *ctx, void *ptr, size_t old, size_t n) {
    (void)ctx;
    if (!n) return 0; /* freed by the next reset */
    if (ptr && (uintptr_t)ptr + old == heap_top) {
        if (n > UINTPTR_MAX - (uintptr_t)ptr || !ensure_memory((uintptr_t)ptr + n)) return 0;
        heap_top = (uintptr_t)ptr + n;
        return ptr;
    }
    uint8_t *p = arena_alloc(n);
    if (p && ptr) {
        const uint8_t *src = ptr;
        for (size_t i = 0; i < old && i < n; i++) p[i] = src[i];
    }
    return p;
}

EXPORT(wxf_reset) void wasm_reset(void) {
    heap_top = heap_start();
    scratch = 0;
    scratch_size = 0;
    writer.data = 0;
    writer.length = writer.capacity = 0;
}

/* memory for input bytes that must stay valid until the next reset */
EXPORT(wxf_alloc) void *wasm_alloc(size_t n) { return arena_alloc(n ? n : 1); }

/* reusable memory for one string argument of a put call */
EXPORT(wxf_scratch) uint8_t *wasm_scratch(size_t n) {
    if (n > scratch_size) {
        size_t size = n > 2 * scratch_size ? n : 2 * scratch_size;
        if (size < 256) size = 256;
        scratch = arena_alloc(size);
        scratch_size = scratch ? size : 0;
    }
    return scratch;
}

/* ---- writer ---- */
EXPORT(wxf_w_begin) int w_begin(void) { return wxf_writer_init(&writer, arena_realloc, 0); }
EXPORT(wxf_w_function) int w_function(uint32_t argc) { return wxf_put_function(&writer, argc); }
EXPORT(wxf_w_symbol) int w_symbol(const char *s, size_t n) { return wxf_put_symbol(&writer, s, n); }
EXPORT(wxf_w_string) int w_string(const char *s, size_t n) { return wxf_put_string(&writer, s, n); }
EXPORT(wxf_w_binary) int w_binary(const uint8_t *b, size_t n) { return wxf_put_binary(&writer, b, n); }
EXPORT(wxf_w_integer) int w_integer(int64_t v) { return wxf_put_integer(&writer, v); }
EXPORT(wxf_w_big_integer) int w_big_integer(const char *s, size_t n) { return wxf_put_big_integer(&writer, s, n); }
EXPORT(wxf_w_real) int w_real(double v) { return wxf_put_real(&writer, v); }
EXPORT(wxf_w_big_real) int w_big_real(const char *s, size_t n) { return wxf_put_big_real(&writer, s, n); }
EXPORT(wxf_w_association) int w_association(uint32_t n) { return wxf_put_association(&writer, n); }
EXPORT(wxf_w_rule) int w_rule(void) { return wxf_put_rule(&writer); }
EXPORT(wxf_w_rule_delayed) int w_rule_delayed(void) { return wxf_put_rule_delayed(&writer); }
EXPORT(wxf_w_array) int w_array(int numeric, int type, size_t rank, const uint32_t *dims, const void *data) {
    uint64_t d[WXF_MAX_RANK];
    if (rank < 1 || rank > WXF_MAX_RANK) return writer.error ? writer.error : (writer.error = WXF_ERR_ARG);
    for (size_t i = 0; i < rank; i++) d[i] = dims[i];
    return wxf_put_array(&writer, numeric, type, rank, d, data);
}
EXPORT(wxf_w_data) const uint8_t *w_data(void) { return writer.data; }
EXPORT(wxf_w_length) size_t w_length(void) { return writer.length; }
EXPORT(wxf_w_error) int w_error(void) { return writer.error; }

/* ---- reader ---- */
EXPORT(wxf_r_begin) int r_begin(const uint8_t *p, size_t n) { return wxf_reader_init(&reader, p, n); }
EXPORT(wxf_r_next) int r_next(void) { return wxf_next(&reader, &token); }
EXPORT(wxf_r_kind) int r_kind(void) { return token.kind; }
EXPORT(wxf_r_integer) int64_t r_integer(void) { return token.integer; }
EXPORT(wxf_r_real) double r_real(void) { return token.real; }
EXPORT(wxf_r_count) double r_count(void) { return (double)token.count; }
EXPORT(wxf_r_bytes) const uint8_t *r_bytes(void) { return token.bytes; }
EXPORT(wxf_r_size) size_t r_size(void) { return token.size; }
EXPORT(wxf_r_array_type) int r_array_type(void) { return token.array_type; }
EXPORT(wxf_r_rank) size_t r_rank(void) { return token.rank; }
EXPORT(wxf_r_dim) double r_dim(size_t i) { return i < token.rank ? (double)token.dims[i] : -1; }
