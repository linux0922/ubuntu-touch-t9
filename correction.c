#define _POSIX_C_SOURCE 200809L
#include "correction.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { MAX_CODE = 25 };

typedef struct {
    char code[MAX_CODE + 1];
    char *data;
    char *pinyin;
    unsigned weight;
} Entry;

static Entry *entries;
static size_t count;

static int entry_order(const void *left, const void *right)
{
    const Entry *a = left;
    const Entry *b = right;
    int comparison = strcmp(a->code, b->code);
    return comparison ? comparison : (b->weight > a->weight) - (a->weight > b->weight);
}

static int encode(const char *pinyin, char code[MAX_CODE + 1])
{
    const char keypad[] = "22233344455566677778889999";
    size_t n = 0;
    for (const char *p = pinyin; *p; ++p) {
        if (*p == ' ')
            continue;
        if (*p < 'a' || *p > 'z' || n == MAX_CODE)
            return 0;
        code[n++] = keypad[*p - 'a'];
    }
    code[n] = '\0';
    return n >= 4;
}

void correction_load(const char *rime_dir)
{
    const char suffix[] = "/cn_dicts/base.dict.yaml";
    size_t length = strlen(rime_dir) + sizeof suffix;
    char *path = malloc(length);
    if (!path)
        return;
    snprintf(path, length, "%s%s", rime_dir, suffix);
    FILE *file = fopen(path, "r");
    free(path);
    if (!file)
        return;

    size_t capacity = 0, line_size = 0;
    char *line = NULL;
    while (getline(&line, &line_size, file) >= 0) {
        if ((unsigned char)line[0] < 0x80)
            continue;
        char *pinyin = strchr(line, '\t');
        if (!pinyin)
            continue;
        *pinyin++ = '\0';
        char *weight_text = strchr(pinyin, '\t');
        if (!weight_text)
            continue;
        *weight_text++ = '\0';
        unsigned long weight = strtoul(weight_text, NULL, 10);
        Entry entry = {0};
        if (weight < 5000 || !strchr(pinyin, ' ') || !encode(pinyin, entry.code))
            continue;
        if (count == capacity) {
            size_t next = capacity ? 2 * capacity : 4096;
            Entry *expanded = realloc(entries, next * sizeof *entries);
            if (!expanded)
                break;
            entries = expanded;
            capacity = next;
        }
        size_t offset = strlen(line) + 1;
        entry.data = malloc(offset + strlen(pinyin) + 1);
        if (!entry.data)
            break;
        memcpy(entry.data, line, offset);
        entry.pinyin = strcpy(entry.data + offset, pinyin);
        entry.weight = weight > 1000000 ? 1000000 : (unsigned)weight;
        entries[count++] = entry;
    }
    free(line);
    fclose(file);
    if (count)
        qsort(entries, count, sizeof *entries, entry_order);
}

static void offer(const Entry *entry, double confidence, Correction results[CORRECTION_COUNT])
{
    double score = entry->weight * confidence;
    for (size_t i = 0; i < CORRECTION_COUNT; ++i) {
        if (results[i].text && !strcmp(results[i].text, entry->data)) {
            if (results[i].score >= score)
                return;
            for (size_t j = i; j + 1 < CORRECTION_COUNT; ++j)
                results[j] = results[j + 1];
            results[CORRECTION_COUNT - 1] = (Correction){0};
            break;
        }
    }
    for (size_t i = 0; i < CORRECTION_COUNT; ++i) {
        if (results[i].score >= score)
            continue;
        for (size_t j = CORRECTION_COUNT - 1; j > i; --j)
            results[j] = results[j - 1];
        results[i] = (Correction){entry->data, entry->pinyin, score};
        break;
    }
}

static void search(const char *code, double confidence, Correction results[CORRECTION_COUNT])
{
    size_t low = 0, high = count;
    while (low < high) {
        size_t middle = low + (high - low) / 2;
        if (strcmp(entries[middle].code, code) < 0)
            low = middle + 1;
        else
            high = middle;
    }
    for (size_t i = low; i < count && i - low < CORRECTION_COUNT &&
         !strcmp(entries[i].code, code); ++i)
        offer(&entries[i], confidence, results);
}

size_t correction_find(const char *input, Correction results[CORRECTION_COUNT])
{
    size_t length = strlen(input);
    if (length < 4 || length >= MAX_CODE || !count ||
        strspn(input, "23456789") != length)
        return 0;

    // A single edit is enough to recover a nearby intended phrase without
    // allowing unrelated dictionary entries into the normal Rime candidates.
    char variant[MAX_CODE + 1];
    for (size_t i = 0; i < length; ++i) {
        char digit = input[i];
        memcpy(variant, input, i);
        strcpy(variant + i, input + i + 1);
        int repeated = (i > 0 && input[i - 1] == digit) || input[i + 1] == digit;
        search(variant, repeated ? 1.0 : 0.55, results);

        strcpy(variant, input);
        for (char key = '2'; key <= '9'; ++key) {
            int dx = abs((digit - '1') % 3 - (key - '1') % 3);
            int dy = abs((digit - '1') / 3 - (key - '1') / 3);
            if (dx + dy == 0 || dx > 1 || dy > 1)
                continue;
            variant[i] = key;
            search(variant, dx + dy == 1 ? 0.78 : 0.55, results);
        }
        if (i + 1 < length && digit != input[i + 1]) {
            variant[i] = input[i + 1];
            variant[i + 1] = digit;
            search(variant, 0.95, results);
        }
    }
    for (size_t i = 0; i <= length; ++i) {
        memcpy(variant, input, i);
        strcpy(variant + i + 1, input + i);
        for (char key = '2'; key <= '9'; ++key) {
            variant[i] = key;
            search(variant, (i == length || i == 0) ? 0.40 : 0.74, results);
        }
    }

    size_t found = 0;
    while (found < CORRECTION_COUNT && results[found].text)
        ++found;
    return found;
}

void correction_free(void)
{
    for (size_t i = 0; i < count; ++i)
        free(entries[i].data);
    free(entries);
}
