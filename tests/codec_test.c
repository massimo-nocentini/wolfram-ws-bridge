/* Native tests of the WXF codec.
 *   codec_test roundtrip FILE...  decode each kernel-made file and re-encode it token by token;
 *                                 the bytes must be identical
 *   codec_test write DIR          write expressions built with the put calls to DIR/w_NN.wxf;
 *                                 tests/check_written.wl compares them with the expected values */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../wxf/wxf.h"

static void *heap_realloc(void *ctx, void *p, size_t old, size_t n) {
    (void)ctx; (void)old;
    if (!n) { free(p); return NULL; }
    return realloc(p, n);
}

static int reencode(const uint8_t *in, size_t n, wxf_writer *w) {
    wxf_reader r;
    wxf_token t;
    int rc = wxf_reader_init(&r, in, n);
    if (rc != WXF_OK) return rc;
    while ((rc = wxf_next(&r, &t)) == WXF_OK) {
        switch (t.kind) {
        case WXF_FUNCTION: wxf_put_function(w, t.count); break;
        case WXF_ASSOCIATION: wxf_put_association(w, t.count); break;
        case WXF_SYMBOL: wxf_put_symbol(w, (const char *)t.bytes, t.size); break;
        case WXF_STRING: wxf_put_string(w, (const char *)t.bytes, t.size); break;
        case WXF_BINARY_STRING: wxf_put_binary(w, t.bytes, t.size); break;
        case WXF_BIG_INTEGER: wxf_put_big_integer(w, (const char *)t.bytes, t.size); break;
        case WXF_BIG_REAL: wxf_put_big_real(w, (const char *)t.bytes, t.size); break;
        case WXF_REAL64: wxf_put_real(w, t.real); break;
        case WXF_RULE: wxf_put_rule(w); break;
        case WXF_RULE_DELAYED: wxf_put_rule_delayed(w); break;
        case WXF_PACKED_ARRAY: case WXF_NUMERIC_ARRAY:
            wxf_put_array(w, t.kind == WXF_NUMERIC_ARRAY, t.array_type, t.rank, t.dims, t.bytes); break;
        default:
            if (wxf_is_integer(t.kind)) wxf_put_integer(w, t.integer);
            else return WXF_ERR_TOKEN;
        }
        if (w->error) return w->error;
    }
    return rc;
}

static uint8_t *read_file(const char *path, size_t *n) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);
    uint8_t *buf = malloc(size ? (size_t)size : 1);
    *n = fread(buf, 1, (size_t)size, f);
    fclose(f);
    return buf;
}

static int roundtrip(int argc, char **argv) {
    int failed = 0;
    for (int i = 0; i < argc; i++) {
        size_t n;
        uint8_t *in = read_file(argv[i], &n);
        wxf_writer w;
        wxf_writer_init(&w, heap_realloc, NULL);
        int rc = in ? reencode(in, n, &w) : -100;
        int same = rc == WXF_END && w.length == n && memcmp(w.data, in, n) == 0;
        if (!same) {
            failed++;
            printf("FAIL %s: rc=%d, %zu bytes in, %zu out\n", argv[i], rc, n, w.length);
        }
        wxf_writer_free(&w);
        free(in);
    }
    printf("roundtrip: %d of %d files identical\n", argc - failed, argc);
    return failed != 0;
}

/* truncated and corrupted inputs must give errors, never read past the end */
static int robustness(void) {
    static const uint8_t good[] = {'8', ':', 'f', 2, 's', 4, 'L', 'i', 's', 't', 'C', 1, 'S', 3, 'a', 'b', 'c'};
    int failed = 0;
    for (size_t cut = 2; cut < sizeof good; cut++) {
        wxf_reader r;
        wxf_token t;
        int rc;
        wxf_reader_init(&r, good, cut);
        while ((rc = wxf_next(&r, &t)) == WXF_OK) {}
        int expect_end = cut == 2 || cut == 4 || cut == 10 || cut == 12; /* cuts that fall between tokens */
        if (expect_end ? rc != WXF_END : rc != WXF_ERR_TRUNCATED) { failed++; printf("FAIL cut %zu rc=%d\n", cut, rc); }
    }
    static const uint8_t bad_varint[] = {'8', ':', 'f', 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x7F};
    static const uint8_t bad_array[] = {'8', ':', 0xC1, 16, 1, 3, 1, 2, 3};  /* unsigned type in a packed array */
    static const uint8_t overflow_array[] = {'8', ':', 0xC1, 3, 2, 0xFF, 0xFF, 0xFF, 0xFF, 0x0F, 0xFF, 0xFF, 0xFF, 0xFF, 0x0F};
    static const uint8_t huge_array[] = {'8', ':', 0xC1, 3, 1, 0xFF, 0xFF, 0xFF, 0x7F, 1, 2};  /* claims 2 GiB of data */
    static const uint8_t compressed[] = {'8', 'C', ':', 'x'};
    struct { const uint8_t *p; size_t n; int rc; } cases[] = {
        {bad_varint, sizeof bad_varint, WXF_ERR_VARINT}, {bad_array, sizeof bad_array, WXF_ERR_ARRAY},
        {overflow_array, sizeof overflow_array, WXF_ERR_ARRAY}, {huge_array, sizeof huge_array, WXF_ERR_TRUNCATED}, {compressed, sizeof compressed, WXF_ERR_COMPRESSED},
    };
    for (size_t i = 0; i < sizeof cases / sizeof cases[0]; i++) {
        wxf_reader r;
        wxf_token t;
        int rc = wxf_reader_init(&r, cases[i].p, cases[i].n);
        while (rc == WXF_OK) rc = wxf_next(&r, &t);
        if (rc != cases[i].rc) { failed++; printf("FAIL bad input %zu rc=%d expected %d\n", i, rc, cases[i].rc); }
    }
    printf("robustness: %s\n", failed ? "FAILED" : "ok");
    return failed != 0;
}

static int save(const char *dir, int index, wxf_writer *w) {
    char path[4096];
    snprintf(path, sizeof path, "%s/w_%02d.wxf", dir, index);
    FILE *f = fopen(path, "wb");
    if (!f || w->error) return 1;
    fwrite(w->data, 1, w->length, f);
    fclose(f);
    wxf_writer_free(w);
    return 0;
}

#define S(s) s, strlen(s)

static int write_cases(const char *dir) {
    wxf_writer w;
    int bad = 0, i = 0;
    /* 0: Integrate[Times[Power[Global`x, 2], Sin[Global`x]], Global`x] */
    wxf_writer_init(&w, heap_realloc, NULL);
    wxf_put_function(&w, 2); wxf_put_symbol(&w, S("Integrate"));
    wxf_put_function(&w, 2); wxf_put_symbol(&w, S("Times"));
    wxf_put_function(&w, 2); wxf_put_symbol(&w, S("Power")); wxf_put_symbol(&w, S("Global`x")); wxf_put_integer(&w, 2);
    wxf_put_function(&w, 1); wxf_put_symbol(&w, S("Sin")); wxf_put_symbol(&w, S("Global`x"));
    wxf_put_symbol(&w, S("Global`x"));
    bad += save(dir, i++, &w);
    /* 1: {integers at each size boundary} */
    static const int64_t ints[] = {0, -1, 127, 128, -129, 40000, -40000, 3000000000LL, INT64_MIN, INT64_MAX};
    wxf_writer_init(&w, heap_realloc, NULL);
    wxf_put_function(&w, 10); wxf_put_symbol(&w, S("List"));
    for (int k = 0; k < 10; k++) wxf_put_integer(&w, ints[k]);
    bad += save(dir, i++, &w);
    /* 2: {big integer, reals, big real, string, ByteArray} */
    wxf_writer_init(&w, heap_realloc, NULL);
    wxf_put_function(&w, 6); wxf_put_symbol(&w, S("List"));
    wxf_put_big_integer(&w, S("-123456789012345678901234567890"));
    wxf_put_real(&w, 0.1); wxf_put_real(&w, -1e300);
    wxf_put_big_real(&w, S("3.14159265358979323846264338327950288`35."));
    wxf_put_string(&w, S("caf\xc3\xa9 \xe2\x88\xab"));
    static const uint8_t blob[] = {0, 1, 2, 254, 255};
    wxf_put_binary(&w, blob, sizeof blob);
    bad += save(dir, i++, &w);
    /* 3: <|"a" -> 1, "b" :> {}|> */
    wxf_writer_init(&w, heap_realloc, NULL);
    wxf_put_association(&w, 2);
    wxf_put_rule(&w); wxf_put_string(&w, S("a")); wxf_put_integer(&w, 1);
    wxf_put_rule_delayed(&w); wxf_put_string(&w, S("b")); wxf_put_function(&w, 0); wxf_put_symbol(&w, S("List"));
    bad += save(dir, i++, &w);
    /* 4: packed {{1., 2., 3.}, {4., 5., 6.}} */
    static const double m[] = {1, 2, 3, 4, 5, 6};
    static const uint64_t dims[] = {2, 3};
    wxf_writer_init(&w, heap_realloc, NULL);
    wxf_put_array(&w, 0, WXF_ARRAY_REAL64, 2, dims, m);
    bad += save(dir, i++, &w);
    /* 5: NumericArray[{1, 2, 250}, "UnsignedInteger8"] */
    static const uint8_t u8[] = {1, 2, 250};
    static const uint64_t dim3[] = {3};
    wxf_writer_init(&w, heap_realloc, NULL);
    wxf_put_array(&w, 1, WXF_ARRAY_UINT8, 1, dim3, u8);
    bad += save(dir, i++, &w);
    /* invalid put calls must be rejected */
    wxf_writer_init(&w, heap_realloc, NULL);
    if (wxf_put_big_integer(&w, S("12a")) != WXF_ERR_ARG) bad++;
    wxf_writer_free(&w);
    wxf_writer_init(&w, heap_realloc, NULL);
    if (wxf_put_array(&w, 0, WXF_ARRAY_UINT8, 1, dim3, u8) != WXF_ERR_ARG) bad++;
    wxf_writer_free(&w);
    printf("write: %d files, %s\n", i, bad ? "FAILED" : "ok");
    return bad != 0;
}

int main(int argc, char **argv) {
    if (argc >= 2 && !strcmp(argv[1], "roundtrip")) return roundtrip(argc - 2, argv + 2) | robustness();
    if (argc == 3 && !strcmp(argv[1], "write")) return write_cases(argv[2]);
    fprintf(stderr, "usage: %s roundtrip FILE... | write DIR\n", argv[0]);
    return 2;
}
