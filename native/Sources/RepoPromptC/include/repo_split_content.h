#pragma once
#include <stddef.h>

struct repo_split_result {
    char **lines;
    size_t line_count;
    char *detected_ending;
};

/* Splits content by line endings while preserving the line content
 * Detects the line ending type used in the content
 * The caller must call repo_free_split_result() when done
 */
struct repo_split_result* repo_split_content_preserving_endings(const char *content);

/* Frees the memory allocated by repo_split_content_preserving_endings */
void repo_free_split_result(struct repo_split_result *result);
