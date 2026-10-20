#pragma once
#include <stddef.h>

int mipmux_decode_utf8(const void *input, size_t input_count, const char *encoding,
                     unsigned char **output, size_t *output_count);
