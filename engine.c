#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <rime_api.h>
#include "correction.h"

static void print_string(const char *text)
{
    putchar('"');
    for (const unsigned char *p = (const unsigned char *)(text ? text : ""); *p; ++p) {
        if (*p == '"' || *p == '\\')
            printf("\\%c", *p);
        else if (*p < 32)
            printf("\\u%04x", *p);
        else
            putchar(*p);
    }
    putchar('"');
}

static void print_state(RimeApi *api, RimeSessionId session)
{
    RIME_STRUCT(RimeCommit, commit);
    RIME_STRUCT(RimeContext, context);
    printf("{\"commit\":");
    if (api->get_commit(session, &commit)) {
        print_string(commit.text);
        api->free_commit(&commit);
    } else {
        print_string("");
    }
    printf(",\"input\":");
    const char *input = api->get_input(session);
    print_string(input);
    printf(",\"candidates\":[");
    if (api->get_context(session, &context)) {
        for (int i = 0; i < context.menu.num_candidates; ++i) {
            if (i)
                putchar(',');
            printf("{\"text\":");
            print_string(context.menu.candidates[i].text);
            printf(",\"pinyin\":");
            print_string(context.menu.candidates[i].comment);
            putchar('}');
        }
        printf("],\"page\":%d,\"last\":%s",
               context.menu.page_no, context.menu.is_last_page ? "true" : "false");
        api->free_context(&context);
    } else {
        printf("],\"page\":0,\"last\":true");
    }
    printf(",\"alternatives\":[");
    RimeCandidateListIterator iterator = {0};
    if (*input && api->candidate_list_begin(session, &iterator)) {
        int max_candidates = strlen(input) > 24 ? 12 : 40;
        for (int i = 0; i < max_candidates && api->candidate_list_next(&iterator); ++i) {
            if (i)
                putchar(',');
            printf("{\"text\":");
            print_string(iterator.candidate.text);
            printf(",\"pinyin\":");
            print_string(iterator.candidate.comment);
            printf(",\"index\":%d}", iterator.index);
        }
        api->candidate_list_end(&iterator);
    }
    printf("],\"corrections\":[");
    Correction corrections[CORRECTION_COUNT] = {0};
    size_t found = correction_find(input, corrections);
    for (size_t i = 0; i < found; ++i) {
        if (i)
            putchar(',');
        printf("{\"text\":");
        print_string(corrections[i].text);
        printf(",\"pinyin\":");
        print_string(corrections[i].pinyin);
        putchar('}');
    }
    puts("]}");
    fflush(stdout);
}

int main(int argc, char **argv)
{
    if (argc != 3)
        return EXIT_FAILURE;

    RIME_STRUCT(RimeTraits, traits);
    traits.shared_data_dir = argv[1];
    traits.user_data_dir = argv[2];
    traits.app_name = "rime.ubuntu-touch-t9";
    traits.min_log_level = 3;
    traits.log_dir = "";
    RimeApi *api = rime_get_api();
    api->setup(&traits);
    api->initialize(&traits);
    RimeSessionId session = api->create_session();
    if (!session || !api->select_schema(session, "t9")) {
        fputs("The Rime t9 schema is unavailable.\n", stderr);
        api->finalize();
        return EXIT_FAILURE;
    }
    api->set_option(session, "ascii_mode", 0);
    api->set_option(session, "emoji", 0);
    api->set_option(session, "traditionalization", 0);
    correction_load(argv[1]);
    print_state(api, session);

    char line[32];
    while (fgets(line, sizeof line, stdin)) {
        if (line[1] == '\n' && line[0] >= '2' && line[0] <= '9') {
            api->process_key(session, line[0], 0);
        } else if (!strcmp(line, "split\n")) {
            if (*api->get_input(session))
                api->process_key(session, '1', 0);
        } else if (!strcmp(line, "back\n")) {
            api->process_key(session, 0xff08, 0);
        } else if (!strcmp(line, "finish\n")) {
            api->commit_composition(session);
        } else if (!strcmp(line, "clear\n")) {
            api->clear_composition(session);
        } else if (!strcmp(line, "next\n")) {
            api->change_page(session, 0);
        } else if (!strcmp(line, "previous\n")) {
            api->change_page(session, 1);
        } else if (!strncmp(line, "select ", 7)) {
            api->select_candidate(session, strtoul(line + 7, NULL, 10));
        } else if (!strncmp(line, "pick ", 5)) {
            api->select_candidate_on_current_page(session, strtoul(line + 5, NULL, 10));
        }
        print_state(api, session);
    }
    correction_free();
    api->destroy_session(session);
    api->finalize();
    return EXIT_SUCCESS;
}
