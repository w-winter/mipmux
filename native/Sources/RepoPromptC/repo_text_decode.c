#ifdef __linux__
#include "repo_text_decode.h"
#include <iconv.h>
#include <stdint.h>
#include <stdlib.h>

int smip_decode_utf8(const void *input, size_t input_count, const char *encoding,
                     unsigned char **output, size_t *output_count) {
    const size_t maximum_utf8_bytes_per_input_byte = 4;
    if (input_count > (SIZE_MAX - maximum_utf8_bytes_per_input_byte) / maximum_utf8_bytes_per_input_byte)
        return -1;
    iconv_t converter = iconv_open("UTF-8", encoding);
    if (converter == (iconv_t)-1) return -1;
    size_t capacity = (input_count + 1) * maximum_utf8_bytes_per_input_byte;
    unsigned char *bytes = malloc(capacity);
    if (!bytes) { iconv_close(converter); return -1; }
    char *from = (char *)input, *to = (char *)bytes;
    size_t remaining_input = input_count, remaining_output = capacity;
    size_t converted = iconv(converter, &from, &remaining_input, &to, &remaining_output);
    int success = converted == 0 && remaining_input == 0 &&
        iconv(converter, NULL, NULL, &to, &remaining_output) == 0;
    iconv_close(converter);
    if (!success) { free(bytes); return -1; }
    *output = bytes;
    *output_count = capacity - remaining_output;
    return 0;
}
#endif
