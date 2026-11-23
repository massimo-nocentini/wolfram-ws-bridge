/* WXF (Wolfram Exchange Format, version 8) encoder and decoder.
 *
 * Written from Wolfram's public description of the format; it uses no Wolfram code and no libc,
 * so it builds both natively and for freestanding wasm32. Compressed WXF ("8C:") is not supported.
 *
 * Writing works like WSTP's put calls: a function is put as its argument count, then its head,
 * then its arguments; an association as its entry count, then per entry a rule token, key, value.
 * Reading returns the same tokens in the same order, one per wxf_next() call.
 */
#ifndef WXF_H
#define WXF_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* token bytes */
enum {
    WXF_FUNCTION = 'f',
    WXF_SYMBOL = 's',
    WXF_STRING = 'S',
    WXF_BINARY_STRING = 'B', /* ByteArray */
    WXF_INTEGER8 = 'C',
    WXF_INTEGER16 = 'j',
    WXF_INTEGER32 = 'i',
    WXF_INTEGER64 = 'L',
    WXF_REAL64 = 'r',
    WXF_BIG_INTEGER = 'I',   /* decimal digits */
    WXF_BIG_REAL = 'R',      /* InputForm text such as 1.5`20. */
    WXF_ASSOCIATION = 'A',
    WXF_RULE = '-',
    WXF_RULE_DELAYED = ':',
    WXF_PACKED_ARRAY = 0xC1,
    WXF_NUMERIC_ARRAY = 0xC2
};

/* element types of packed and numeric arrays (unsigned types only in numeric arrays) */
enum {
    WXF_ARRAY_INT8 = 0, WXF_ARRAY_INT16 = 1, WXF_ARRAY_INT32 = 2, WXF_ARRAY_INT64 = 3,
    WXF_ARRAY_UINT8 = 16, WXF_ARRAY_UINT16 = 17, WXF_ARRAY_UINT32 = 18, WXF_ARRAY_UINT64 = 19,
    WXF_ARRAY_REAL32 = 34, WXF_ARRAY_REAL64 = 35,
    WXF_ARRAY_COMPLEX64 = 51, WXF_ARRAY_COMPLEX128 = 52
};

/* results; errors are negative */
enum {
    WXF_OK = 1,
    WXF_END = 0,
    WXF_ERR_TRUNCATED = -1,  /* input ends inside a token */
    WXF_ERR_HEADER = -2,     /* not "8:" */
    WXF_ERR_COMPRESSED = -3, /* "8C:" */
    WXF_ERR_TOKEN = -4,      /* unknown token byte */
    WXF_ERR_VARINT = -5,     /* malformed or oversized length */
    WXF_ERR_ARRAY = -6,      /* bad array type or rank, or more than WXF_MAX_ARRAY_BYTES */
    WXF_ERR_NOMEM = -7,
    WXF_ERR_ARG = -8         /* invalid argument to a put call */
};

#define WXF_MAX_RANK 32
/* largest array payload accepted, in bytes; keeps size arithmetic free of 64-bit overflow */
#define WXF_MAX_ARRAY_BYTES ((uint64_t)1 << 48)

#define wxf_is_integer(kind) ((kind) == WXF_INTEGER8 || (kind) == WXF_INTEGER16 || \
                              (kind) == WXF_INTEGER32 || (kind) == WXF_INTEGER64)

/* Allocation callback: (ctx, NULL, 0, n) allocates, (ctx, p, old, n) resizes, (ctx, p, old, 0) frees.
 * Compiling wxf.c with -DWXF_REALLOC=name calls the function name instead (same signature). */
typedef void *(*wxf_realloc_fn)(void *ctx, void *ptr, size_t old_size, size_t new_size);

typedef struct {
    uint8_t *data;
    size_t length, capacity;
    int error;               /* first error, 0 if none; later puts do nothing */
    wxf_realloc_fn realloc_fn;
    void *ctx;
} wxf_writer;

/* Starts a buffer holding the "8:" header. Returns WXF_OK or an error. */
int wxf_writer_init(wxf_writer *w, wxf_realloc_fn realloc_fn, void *ctx);
void wxf_writer_free(wxf_writer *w);

int wxf_put_function(wxf_writer *w, uint64_t argc);
int wxf_put_symbol(wxf_writer *w, const char *name, size_t length);   /* e.g. "Integrate", "Global`x" */
int wxf_put_string(wxf_writer *w, const char *utf8, size_t length);
int wxf_put_binary(wxf_writer *w, const uint8_t *bytes, size_t length);
int wxf_put_integer(wxf_writer *w, int64_t value);                    /* smallest integer token */
int wxf_put_big_integer(wxf_writer *w, const char *digits, size_t length); /* optional '-' then digits */
int wxf_put_real(wxf_writer *w, double value);
int wxf_put_big_real(wxf_writer *w, const char *text, size_t length);
int wxf_put_association(wxf_writer *w, uint64_t count);
int wxf_put_rule(wxf_writer *w);
int wxf_put_rule_delayed(wxf_writer *w);
/* Packed (numeric = 0) or numeric (numeric = 1) array; data holds the elements in row-major
 * little-endian order, complex numbers as (re, im) pairs. */
int wxf_put_array(wxf_writer *w, int numeric, int type, size_t rank, const uint64_t *dims,
                  const void *data);

typedef struct {
    const uint8_t *pos, *end;
} wxf_reader;

typedef struct {
    int kind;                /* token byte */
    int64_t integer;         /* integer tokens */
    double real;             /* WXF_REAL64 */
    uint64_t count;          /* function argument count, association entry count */
    const uint8_t *bytes;    /* symbol, string, ByteArray, big number text, array data */
    size_t size;             /* length of bytes */
    int array_type;
    size_t rank;
    uint64_t dims[WXF_MAX_RANK];
} wxf_token;

/* Checks the header. The reader keeps pointing into data, which must stay valid. */
int wxf_reader_init(wxf_reader *r, const uint8_t *data, size_t length);
/* WXF_OK with the next token, WXF_END at the end of input, or an error. */
int wxf_next(wxf_reader *r, wxf_token *t);

/* Bytes per element, 0 if the type is unknown. */
size_t wxf_array_element_size(int type);

#ifdef __cplusplus
}
#endif

#endif
