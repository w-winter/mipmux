// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3.
// Modified: separate line allocation and ending classification to satisfy complexity limits.
#include "repo_split_content.h"
#include <stdlib.h>
#include <string.h>

static int repo_append_split_line(struct repo_split_result *result, size_t *capacity,
                                  const char *line_start, const char *line_end) {
    size_t line_len = line_end - line_start;
    char *line = malloc(line_len + 1);
    if (!line) return 0;
    memcpy(line, line_start, line_len);
    line[line_len] = '\0';
    if (result->line_count >= *capacity) {
        *capacity *= 2;
        char **new_lines = realloc(result->lines, *capacity * sizeof(char*));
        if (!new_lines) {
            free(line);
            return 0;
        }
        result->lines = new_lines;
    }
    result->lines[result->line_count++] = line;
    return 1;
}

static char *repo_detect_split_ending(size_t unix_count, size_t windows_count, size_t mac_count, int last_end) {
    char *ending;
    /* Determine the line ending to report */
    if (windows_count > unix_count && windows_count > mac_count) {
        ending = strdup("\r\n");
    } else if (mac_count > unix_count && mac_count > windows_count) {
        ending = strdup("\r");
    } else if (unix_count > windows_count && unix_count > mac_count) {
        ending = strdup("\n");
    } else {
        /* Counts are tied – use the last one we saw, default to '\n' */
        switch (last_end) {
            case 1:  ending = strdup("\r\n"); break;
            case 2:  ending = strdup("\r");   break;
            case 3:  ending = strdup("\n");   break;
            default: ending = strdup("\n");   break;
        }
    }

    return ending;
}

static struct repo_split_result *repo_begin_split_content(const char *content, size_t capacity) {
    if (!content) return NULL;
    struct repo_split_result *result = malloc(sizeof(struct repo_split_result));
    if (!result) return NULL;
    result->lines = malloc(capacity * sizeof(char*));
    if (!result->lines) {
        free(result);
        return NULL;
    }
    result->line_count = 0;
    result->detected_ending = NULL;
    return result;
}

static int repo_append_split_tail(struct repo_split_result *result, size_t *capacity,
                                  const char *line_start, const char *line_end) {
    if (line_start < line_end) return repo_append_split_line(result, capacity, line_start, line_end);
    return 1;
}

struct repo_split_result* repo_split_content_preserving_endings(const char *content) {
    /* Initial capacity for lines array */
    size_t capacity = 16;
    struct repo_split_result *result = repo_begin_split_content(content, capacity);
    if (!result) return NULL;

    /* Count occurrences of each line ending type */
    size_t unix_count   = 0;  /* \n   */
    size_t windows_count= 0;  /* \r\n */
    size_t mac_count    = 0;  /* \r   */
    int    last_end     = 0;  /* 1 = \r\n, 2 = \r, 3 = \n               */

    const char *line_start = content;
    const char *p = content;

    while (*p) {
        /* Check for line endings */
        if (*p == '\r') {
            /* Check for \r\n (Windows) */
            if (*(p + 1) == '\n') {
                windows_count++;
                last_end = 1;

                /* Extract line */
                if (!repo_append_split_line(result, &capacity, line_start, p)) goto error;

                p += 2; /* Skip \r\n */
                line_start = p;
                continue;
            } else {
                /* Mac-style ending (just \r) */
                mac_count++;
                last_end = 2;

                /* Extract line */
                if (!repo_append_split_line(result, &capacity, line_start, p)) goto error;

                p++;
                line_start = p;
                continue;
            }
        } else if (*p == '\n') {
            /* Unix-style ending */
            unix_count++;
            last_end = 3;

            /* Extract line */
            if (!repo_append_split_line(result, &capacity, line_start, p)) goto error;

            p++;
            line_start = p;
            continue;
        }
        p++;
    }

    /* Handle the last line if there's content after the last line ending */
    if (!repo_append_split_tail(result, &capacity, line_start, p)) goto error;

    result->detected_ending = repo_detect_split_ending(unix_count, windows_count, mac_count, last_end);

    return result;

error:
    /* Clean up on error */
    repo_free_split_result(result);
    return NULL;
}

/**
 * Frees the memory allocated by repo_split_content_preserving_endings
 */
void repo_free_split_result(struct repo_split_result *result) {
    if (!result) return;

    for (size_t i = 0; i < result->line_count; i++) {
        free(result->lines[i]);
    }
    free(result->lines);
    free(result->detected_ending);
    free(result);
}
