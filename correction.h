#ifndef TOUCH_T9_CORRECTION_H
#define TOUCH_T9_CORRECTION_H
#include <stddef.h>

#define CORRECTION_COUNT 4

typedef struct {
    const char *text;
    const char *pinyin;
    double score;
} Correction;

void correction_load(const char *rime_dir);
size_t correction_find(const char *input, Correction results[CORRECTION_COUNT]);
void correction_free(void);
#endif
