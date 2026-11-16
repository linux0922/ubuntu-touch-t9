CC ?= cc
CFLAGS ?= -O2 -Wall -Wextra
LDLIBS ?= -lrime

BUILD_DIR := build
ENGINE := $(BUILD_DIR)/engine
PACKAGE := $(BUILD_DIR)/ubuntu-touch-t9.shell-extension.zip
EXTENSION_FILES := metadata.json extension.js minimizable-keyboard.js stylesheet.css

.PHONY: all clean

all: $(PACKAGE)

$(BUILD_DIR):
	mkdir -p "$@"

$(ENGINE): engine.c correction.c correction.h Makefile | $(BUILD_DIR)
	$(CC) $(CPPFLAGS) $(CFLAGS) -std=c11 $(LDFLAGS) -o "$@" engine.c correction.c $(LDLIBS)

$(PACKAGE): $(ENGINE) $(EXTENSION_FILES) Makefile
	zip -q -j "$@" $(EXTENSION_FILES) "$(ENGINE)"

clean:
	$(RM) "$(ENGINE)" "$(PACKAGE)"
