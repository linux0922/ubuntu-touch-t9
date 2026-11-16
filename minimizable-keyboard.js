import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {QuickToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {Switch} from 'resource:///org/gnome/shell/ui/popupMenu.js';

const LETTERS = ['', '分词', 'ABC', 'DEF', 'GHI', 'JKL', 'MNO', 'PQRS', 'TUV', 'WXYZ'];
const SHORTCUTS = ['，', '。', '？', '！'];
const WIDTHS = [360, 440, 540, 650, 760];
const DEFAULT_SIZE = 2;
const MIN_WIDTH = WIDTHS[0];
const MAX_WIDTH = 900;
const MIN_KEY_HEIGHT = 38;
const MAX_KEY_HEIGHT = 100;
const MIN_OPACITY = 50;
const MAX_OPACITY = 100;
const RESTORE_SIZE = 42;
const EDGE_INSET = 46; // Two 16px side grips, 6px padding on each side, and the border.
const SPELLINGS_PER_PAGE = 4;
const CORRECTION = Symbol('correction');
const STATE_DIR = GLib.build_filenamev([GLib.get_user_state_dir(), 'ubuntu-touch-t9']);
const SIZE_FILE = GLib.build_filenamev([STATE_DIR, 'size']);
const LAYOUT_FILE = GLib.build_filenamev([STATE_DIR, 'layout.json']);
const SYMBOLS = ['，', '。', '？', '！', '、', '：', '；', '（', '）', '…'];
const EMPTY = {input: '', candidates: [], alternatives: [], corrections: [], page: 0, last: true};
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const cleanPinyin = value => value?.replace(/[^a-zü' ]/gi, '').trim().replace(/ +/g, ' ') || '';
const pinyinCode = pinyin => pinyin.replace(/[a-z]/gi, char =>
    '22233344455566677778889999'[char.toLowerCase().charCodeAt(0) - 97]).replaceAll(' ', '').replaceAll("'", '');

const Indicator = GObject.registerClass(class TouchT9MinimizableKeyboardIndicator extends SystemIndicator {
    _init(open) {
        super._init();
        this.toggle = new QuickToggle({
            title: '九宫格拼音',
            iconName: 'input-keyboard-symbolic',
            toggleMode: true,
        });
        this.toggle.connect('clicked', () => open(this.toggle.checked));
        this.quickSettingsItems.push(this.toggle);
    }

    destroy() {
        this.toggle.destroy();
        super.destroy();
    }
});

class Engine {
    constructor(executable) {
        const data = GLib.build_filenamev([GLib.get_user_data_dir(), 'fcitx5', 'rime']);
        if (GLib.mkdir_with_parents(STATE_DIR, 0o700) !== 0)
            throw new Error('无法创建九宫格词库目录');

        const flags = Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE;
        this.process = Gio.Subprocess.new([executable, data, STATE_DIR], flags);
        this.output = this.process.get_stdin_pipe();
        this.input = new Gio.DataInputStream({base_stream: this.process.get_stdout_pipe()});
        this.cancel = new Gio.Cancellable();
        this.ready = this._read();
        // The first key can reuse this handshake even if the panel is still closed.
        this.ready.catch(() => {});
    }

    _read() {
        return new Promise((resolve, reject) => {
            this.input.read_line_async(GLib.PRIORITY_DEFAULT, this.cancel, (stream, result) => {
                try {
                    const [line] = stream.read_line_finish_utf8(result);
                    if (line === null)
                        throw new Error('Rime 九键进程已退出');
                    resolve(JSON.parse(line));
                } catch (error) {
                    reject(error);
                }
            });
        });
    }

    async send(command) {
        await this.ready;
        this.output.write_all(new TextEncoder().encode(command + '\n'), this.cancel);
        return this._read();
    }

    close() {
        this.cancel.cancel();
        this.output.close(null);
    }
}

export default class TouchT9Extension extends Extension {
    enable() {
        this._keys = [];
        this._keyHeights = [];
        this._englishKeyRows = [];
        this._englishLetters = [];
        this._englishExtra = 0;
        this._shift = false;
        this._minimized = false;
        this._language = 'pinyin';
        this._keyMetrics = null;
        this._queue = [];
        this._generation = (this._generation ?? 0) + 1;
        this._layout = this._readLayout();
        this._dragSignal = 0;
        this._dragTimer = 0;
        this._opacitySaveTimer = 0;
        this._clearChoice();
        this._mode = 'pinyin';
        this._state = EMPTY;
        this._device = Clutter.get_default_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        this._build();
        this._indicator = new Indicator(show => {
            this._setVisible(show);
            if (show)
                Main.panel.statusArea.quickSettings.menu.close();
        });
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
        this._monitorId = Main.layoutManager.connect('monitors-changed', () => this._place());
        this._focusId = global.display.connect('notify::focus-window', () => this._reset());
        this._warmEngine();
        this._sessionId = Main.sessionMode.connect('updated', () => {
            if (Main.sessionMode.isLocked)
                this._setVisible(false);
        });
    }

    disable() {
        ++this._generation;
        this._queue = [];
        this._finishDrag();
        this._flushOpacity();
        this._panel.destroy();
        this._restoreButton.destroy();
        this._panel = null;
        this._indicator.destroy();
        Main.layoutManager.disconnect(this._monitorId);
        global.display.disconnect(this._focusId);
        Main.sessionMode.disconnect(this._sessionId);
        this._engine?.close();
        this._engine = null;
        this._device = null;
    }

    _row(style = 'touch-t9-row') {
        const row = new St.BoxLayout({style_class: style});
        this._content.add_child(row);
        return row;
    }

    _button(row, label, name, action, style = '', onPress = false) {
        const button = new St.Button({
            label,
            accessible_name: name,
            style_class: `touch-t9-key ${style}`,
            x_expand: true,
            reactive: true,
            can_focus: false,
        });
        button.connect('clicked', action);
        let touch = null;
        button.connect('touch-event', (_actor, event) => {
            const slot = event.get_event_sequence().get_slot();
            switch (event.type()) {
            case Clutter.EventType.TOUCH_BEGIN:
                touch = slot;
                button.add_style_pseudo_class('active');
                if (onPress)
                    action();
                break;
            case Clutter.EventType.TOUCH_END:
            case Clutter.EventType.TOUCH_CANCEL:
                if (touch === slot) {
                    touch = null;
                    button.remove_style_pseudo_class('active');
                    const [x, y] = event.get_coords();
                    const [bx, by] = button.get_transformed_position();
                    const [width, height] = button.get_transformed_size();
                    if (!onPress && event.type() === Clutter.EventType.TOUCH_END &&
                        x >= bx && x < bx + width && y >= by && y < by + height)
                        action();
                }
                break;
            }
            return Clutter.EVENT_STOP;
        });
        row?.add_child(button);
        return button;
    }

    _build() {
        this._panel = new St.BoxLayout({
            vertical: true,
            style_class: 'touch-t9-panel',
            reactive: true,
            visible: false,
            offscreen_redirect: Clutter.OffscreenRedirect.AUTOMATIC_FOR_OPACITY,
        });
        this._panel.add_child(this._resizeEdge('top'));
        const body = this._body = new St.BoxLayout({clip_to_allocation: true});
        this._panel.add_child(body);
        body.add_child(this._resizeEdge('left'));
        this._content = new St.BoxLayout({
            vertical: true, x_expand: true, clip_to_allocation: true, style_class: 'touch-t9-content',
        });
        body.add_child(this._content);
        body.add_child(this._resizeEdge('right'));
        this._panel.add_child(this._resizeEdge('bottom'));

        const header = this._row('touch-t9-header');
        this._moveGrip = new St.Bin({
            reactive: true,
            x_expand: true,
            y_expand: true,
            style_class: 'touch-t9-grip',
            accessible_name: '拖动标题栏移动键盘',
            child: new St.Label({text: '⠿  九宫格拼音', style_class: 'touch-t9-title'}),
        });
        header.add_child(this._moveGrip);
        this._connectGrip(this._moveGrip, 'move');
        this._settingsButton = this._button(header, '', '键盘设置',
            () => this._showSettings(!this._settingsRow.visible), 'touch-t9-small');
        this._settingsButton.set_child(new St.Icon({icon_name: 'emblem-system-symbolic', icon_size: 16}));
        this._minimizeButton = this._button(header, '▁', '最小化键盘',
            () => this._setMinimized(true), 'touch-t9-small');
        this._closeButton = this._button(header, '×', '收起键盘',
            () => this._setVisible(false), 'touch-t9-small touch-t9-close');
        this._restoreButton = this._button(null, '', '恢复九宫格键盘',
            () => this._setMinimized(false), 'touch-t9-small touch-t9-restore');
        this._restoreButton.set_child(new St.Icon({icon_name: 'input-keyboard-symbolic', icon_size: 20}));
        this._restoreButton.set_size(RESTORE_SIZE, RESTORE_SIZE);
        this._restoreButton.visible = false;
        this._buildSettings();

        this._suggestions = new St.BoxLayout({
            vertical: true, clip_to_allocation: true, style_class: 'touch-t9-suggestions',
        });
        this._content.add_child(this._suggestions);
        const spellingRow = this._spellingRow = new St.BoxLayout({
            clip_to_allocation: true, style_class: 'touch-t9-spelling-row',
        });
        this._suggestions.add_child(spellingRow);
        this._preedit = new St.Label({
            style_class: 'touch-t9-preedit',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._preedit.clutter_text.ellipsize = Pango.EllipsizeMode.START;
        spellingRow.add_child(this._preedit);
        this._spellingButtons = Array.from({length: SPELLINGS_PER_PAGE}, (_, index) => {
            const button = this._button(spellingRow, '', '拼音候选', () => {
                const pinyin = this._shownSpellings[index];
                if (pinyin)
                    this._choose(this._choice === pinyin ? null : pinyin);
            }, 'touch-t9-spelling');
            const label = new St.Label({y_align: Clutter.ActorAlign.CENTER});
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            button.set_child(label);
            button.x_expand = false;
            return button;
        });
        this._moreSpellings = this._button(spellingRow, '›', '更多拼音候选', () => {
            this._spellingPage = (this._spellingPage + 1) % this._spellingPageCount;
            this._render();
        }, 'touch-t9-spelling-next');
        this._moreSpellings.x_expand = false;
        spellingRow.add_child(new St.Widget({x_expand: true}));
        this._correctionButton = this._button(spellingRow, '纠错', '查看纠错候选',
            () => this._choose(this._choice === CORRECTION ? null : CORRECTION),
            'touch-t9-correction');
        this._correctionButton.x_expand = false;
        const candidates = this._wordRow = new St.BoxLayout({
            clip_to_allocation: true, style_class: 'touch-t9-word-row',
        });
        this._suggestions.add_child(candidates);
        this._candidateButtons = Array.from({length: 5}, (_, index) => {
            const label = new St.Label({y_align: Clutter.ActorAlign.CENTER});
            label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            label.clutter_text.line_wrap = true;
            label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            label.clutter_text.line_alignment = Pango.Alignment.CENTER;
            const button = this._button(candidates, '', '候选词',
                () => this._act('pick', {candidate: this._shown[index], state: this._state}),
                'touch-t9-candidate');
            button.set_child(label);
            return {button, label};
        });
        candidates.add_child(new St.Widget({x_expand: true}));
        this._previous = this._button(candidates, '‹', '上一页候选', () => this._act('previous'),
            'touch-t9-page');
        this._next = this._button(candidates, '›', '下一页候选', () => this._act('next'),
            'touch-t9-page');
        for (const button of [this._previous, this._next, ...this._candidateButtons.map(key => key.button)])
            button.x_expand = false;

        this._chineseKeys = new St.BoxLayout({vertical: true, style_class: 'touch-t9-content'});
        this._content.add_child(this._chineseKeys);
        const sideKeys = [
            ['⌫', '退格', () => this._act('back')],
            ['清空', '清空拼音', () => this._act(this._mode === 'number' ? 'digit' : 'clear', 0)],
            ['符号', '切换符号键盘',
                () => this._act('mode', this._mode === 'symbol' ? this._language : 'symbol')],
        ];
        for (let index = 0; index < 3; index++) {
            const row = new St.BoxLayout({style_class: 'touch-t9-row'});
            this._chineseKeys.add_child(row);
            this._shortcut(row, SHORTCUTS[index]);
            for (let digit = 1 + index * 3; digit <= 3 + index * 3; digit++)
                this._addDigit(row, digit);
            const [label, name, action] = sideKeys[index];
            const key = this._key(row, label, name, action, 'touch-t9-action', index !== 2);
            if (index === 1)
                this._clearKey = key;
            if (index === 2)
                this._symbolsKey = key;
        }

        const bottom = new St.BoxLayout({style_class: 'touch-t9-row'});
        this._chineseKeys.add_child(bottom);
        this._shortcut(bottom, SHORTCUTS[3]);
        this._modeKey = this._key(bottom, '123', '切换数字键盘',
            () => this._act('mode', this._mode === 'pinyin' ? 'number' : this._language),
            'touch-t9-action', false);
        this._spaceKey = this._key(bottom, '空格', '选首词或输入空格',
            () => this._act('space'), 'touch-t9-action touch-t9-space');
        this._languageKey = this._key(bottom, '英', '切换英文键盘',
            () => this._act('language'), 'touch-t9-action', false);
        this._key(bottom, '↵', '回车', () => this._act('enter'), 'touch-t9-action');
        this._buildEnglish();
        Main.layoutManager.addTopChrome(this._panel);
        Main.layoutManager.addTopChrome(this._restoreButton);
        this._render();
    }

    _buildEnglish() {
        this._englishKeys = new St.BoxLayout({vertical: true, style_class: 'touch-t9-content'});
        this._content.add_child(this._englishKeys);
        const row = () => {
            const box = new St.BoxLayout({style_class: 'touch-t9-english-row'});
            this._englishKeys.add_child(box);
            this._englishKeyRows.push(box);
            return box;
        };
        const key = (box, label, name, handler, style = '', onPress = true) =>
            this._button(box, label, name, handler, `touch-t9-english-key ${style}`, onPress);
        const letters = (box, chars) => {
            for (const char of chars) {
                const button = key(box, char, char, () => this._act('english-text', char));
                this._englishLetters.push({button, char});
            }
        };

        letters(row(), 'qwertyuiop');
        letters(row(), 'asdfghjkl');
        const third = row();
        this._shiftKey = key(third, '⇧', '大写下一字母', () => this._act('shift'), 'touch-t9-action');
        letters(third, 'zxcvbnm');
        key(third, '⌫', '退格', () => this._act('back'), 'touch-t9-action');
        const bottom = row();
        key(bottom, '123', '切换数字键盘', () => this._act('mode', 'number'), 'touch-t9-action', false);
        key(bottom, ',', '逗号', () => this._act('english-text', ','), 'touch-t9-action');
        key(bottom, 'space', '空格', () => this._act('space'), 'touch-t9-action touch-t9-english-space');
        key(bottom, '.', '句号', () => this._act('english-text', '.'), 'touch-t9-action');
        this._englishLanguageKey = key(bottom, '中', '切换中文九宫格',
            () => this._act('language'), 'touch-t9-action', false);
        key(bottom, '↵', '回车', () => this._act('enter'), 'touch-t9-action');
    }

    _resizeEdge(edge) {
        const vertical = edge === 'left' || edge === 'right';
        const grip = new St.Bin({
            reactive: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
            style_class: `touch-t9-edge ${vertical ? 'touch-t9-edge-side' : 'touch-t9-edge-horizontal'}`,
            accessible_name: vertical ? '向左右拖动调整宽度' : '向上下拖动调整高度',
            child: new St.Widget({
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: vertical ? 'touch-t9-edge-line-side' : 'touch-t9-edge-line-horizontal',
            }),
        });
        this._connectGrip(grip, edge);
        if (vertical) {
            if (edge === 'left')
                this._leftGrip = grip;
            else
                this._rightGrip = grip;
        }
        return grip;
    }

    _buildSettings() {
        this._settingsRow = this._row('touch-t9-settings');
        this._settingsRow.vertical = true;
        this._settingsRow.visible = false;
        const opacityRow = new St.BoxLayout({style_class: 'touch-t9-settings-control'});
        this._settingsRow.add_child(opacityRow);
        const align = Clutter.ActorAlign.CENTER;
        opacityRow.add_child(new St.Label({text: '不透明度', y_align: align}));
        this._opacitySlider = new Slider((this._layout.opacity - MIN_OPACITY) / (MAX_OPACITY - MIN_OPACITY));
        this._opacitySlider.x_expand = true;
        this._opacitySlider.y_align = align;
        this._opacitySlider.accessible_name = '键盘不透明度';
        this._opacitySlider.add_style_class_name('touch-t9-opacity-slider');
        opacityRow.add_child(this._opacitySlider);
        this._opacityLabel = new St.Label({style_class: 'touch-t9-opacity-value', y_align: align});
        opacityRow.add_child(this._opacityLabel);
        this._applyOpacity();
        this._opacitySlider.connect('notify::value', () => {
            this._layout.opacity = Math.round(MIN_OPACITY +
                this._opacitySlider.value * (MAX_OPACITY - MIN_OPACITY));
            this._applyOpacity();
            if (this._opacitySaveTimer)
                GLib.source_remove(this._opacitySaveTimer);
            this._opacitySaveTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 180, () => {
                this._opacitySaveTimer = 0;
                this._saveLayout();
                return GLib.SOURCE_REMOVE;
            });
        });

        const lockRow = new St.BoxLayout();
        this._settingsRow.add_child(lockRow);
        this._widthLockButton = this._button(lockRow, '', '锁定键盘宽度', () => {
            this._layout.widthLocked = !this._layout.widthLocked;
            this._syncWidthLock();
            this._saveLayout();
        }, 'touch-t9-width-lock');
        const lockFace = new St.BoxLayout();
        lockFace.add_child(new St.Label({text: '锁定宽度', x_expand: true, y_align: align}));
        this._widthSwitch = new Switch(this._layout.widthLocked);
        this._widthSwitch.y_align = align;
        this._widthSwitch.reactive = false;
        lockFace.add_child(this._widthSwitch);
        this._widthLockButton.set_child(lockFace);
        this._syncWidthLock();
    }

    _syncWidthLock() {
        const locked = this._layout.widthLocked;
        this._widthSwitch.state = locked;
        this._widthLockButton.accessible_name = locked ? '宽度已锁定，点按解锁' : '宽度可调，点按锁定';
        for (const grip of [this._leftGrip, this._rightGrip]) {
            grip.reactive = !locked;
            if (locked)
                grip.add_style_pseudo_class('locked');
            else
                grip.remove_style_pseudo_class('locked');
        }
    }

    _applyOpacity() {
        const alpha = Math.round(this._layout.opacity * 255 / MAX_OPACITY);
        this._panel.opacity = alpha;
        this._restoreButton.opacity = alpha;
        this._opacityLabel.text = `${this._layout.opacity}%`;
    }

    _flushOpacity() {
        if (!this._opacitySaveTimer)
            return;
        GLib.source_remove(this._opacitySaveTimer);
        this._opacitySaveTimer = 0;
        this._saveLayout();
    }

    _showSettings(show) {
        this._settingsRow.visible = show;
        if (show)
            this._settingsButton.add_style_pseudo_class('selected');
        else {
            this._settingsButton.remove_style_pseudo_class('selected');
            this._flushOpacity();
        }
        if (this._panel.visible)
            this._place();
    }

    _key(row, label, name, action, style, onPress = true) {
        const button = this._button(row, label, name, action, style, onPress);
        this._keyHeights.push(button);
        return button;
    }

    _shortcut(row, symbol) {
        this._key(row, symbol, symbol, () => this._act('punctuation', symbol),
            'touch-t9-action touch-t9-shortcut');
    }

    _addDigit(row, digit) {
        const button = this._key(row, '', '', () => this._act('digit', digit), 'touch-t9-digit');
        const face = new St.BoxLayout({vertical: true, x_align: Clutter.ActorAlign.CENTER});
        const caption = new St.Label({x_align: Clutter.ActorAlign.CENTER});
        const number = new St.Label({
            text: String(digit),
            style_class: 'touch-t9-number',
            x_align: Clutter.ActorAlign.CENTER,
        });
        face.add_child(caption);
        face.add_child(number);
        button.set_child(face);
        this._keys.push({digit, button, caption, number});
    }

    _setMinimized(minimized) {
        if (!this._indicator.toggle.checked || minimized === this._minimized)
            return;
        this._finishDrag();
        this._minimized = minimized;
        this._panel.visible = !minimized;
        if (minimized) {
            this._showSettings(false);
            this._place();
        } else {
            this._render();
        }
        this._restoreButton.visible = minimized;
    }

    _setVisible(show) {
        if (!show)
            this._finishDrag();
        this._indicator.toggle.checked = show;
        this._minimized = false;
        this._restoreButton.visible = false;
        this._panel.visible = show;
        if (!show)
            this._showSettings(false);
        if (show) {
            this._mode = this._language;
            this._warmEngine();
        }
        this._reset();
    }

    _readLayout() {
        const defaults = {width: WIDTHS[DEFAULT_SIZE], keyHeight: null, position: null,
            atTop: false, widthLocked: true, opacity: this._touchpadOpacity()};
        const read = file => new TextDecoder().decode(GLib.file_get_contents(file)[1]);
        try {
            const {width, keyHeight, position, atTop, opacity, widthLocked} = JSON.parse(read(LAYOUT_FILE));
            return {
                width: Number.isFinite(width) ? clamp(width, MIN_WIDTH, MAX_WIDTH) : defaults.width,
                keyHeight: Number.isFinite(keyHeight) ? clamp(keyHeight, MIN_KEY_HEIGHT, MAX_KEY_HEIGHT) : null,
                position: Number.isFinite(position?.x) && Number.isFinite(position?.bottom)
                    ? {x: position.x, bottom: position.bottom} : null,
                atTop: atTop === true,
                widthLocked: widthLocked !== false,
                opacity: Number.isFinite(opacity) ? clamp(Math.round(opacity), MIN_OPACITY, MAX_OPACITY)
                    : defaults.opacity,
            };
        } catch {
            try {
                defaults.width = WIDTHS[Number(read(SIZE_FILE))] ?? defaults.width;
            } catch {
                // No saved size on a fresh installation.
            }
            return defaults;
        }
    }

    _saveLayout() {
        try {
            if (GLib.mkdir_with_parents(STATE_DIR, 0o700) === 0)
                GLib.file_set_contents(LAYOUT_FILE, JSON.stringify(this._layout));
        } catch (error) {
            console.warn(`九宫格位置保存失败: ${error.message}`);
        }
    }

    _touchpadOpacity() {
        const touchpad = Main.extensionManager.lookup('screen-touchpad@codex.local');
        if (!touchpad)
            return MAX_OPACITY;
        try {
            const directory = touchpad.dir.get_child('schemas').get_path();
            const source = Gio.SettingsSchemaSource.new_from_directory(directory,
                Gio.SettingsSchemaSource.get_default(), false);
            const schema = source.lookup('org.gnome.shell.extensions.screen-touchpad', false);
            if (schema)
                return new Gio.Settings({settings_schema: schema}).get_int('opacity');
        } catch (error) {
            console.debug(`触控板不透明度读取失败: ${error.message}`);
        }
        return MAX_OPACITY;
    }

    _currentMonitor() {
        const position = this._layout.position;
        if (position) {
            const monitor = Main.layoutManager.monitors.find(m =>
                position.x >= m.x && position.x < m.x + m.width &&
                position.bottom > m.y && position.bottom <= m.y + m.height);
            if (monitor)
                return monitor;
        }
        return Main.layoutManager.findMonitorForActor(this._panel) ?? Main.layoutManager.primaryMonitor;
    }

    _place(monitor = this._currentMonitor(), anchorTop = null) {
        if (!monitor)
            return;
        const width = Math.min(this._layout.width, monitor.width - 24);
        this._panel.width = width;
        const contentWidth = width - EDGE_INSET;
        if (this._content.width !== contentWidth) {
            // Pin the label containers before measuring wrapped text. Clutter
            // must never use their natural, unwrapped widths to allocate the body.
            this._body.width = contentWidth + 32;
            for (const actor of [this._content, this._suggestions, this._spellingRow, this._wordRow])
                actor.width = contentWidth;
        }
        const keyHeight = this._layout.keyHeight ?? clamp(Math.round(width * 0.108), 44, 76);
        const fontSize = clamp(Math.round(Math.min(width * 0.032, keyHeight * 0.42)), 14, 26);
        const metrics = `${width}/${keyHeight}/${this._englishExtra}`;
        if (this._keyMetrics !== metrics) {
            this._keyMetrics = metrics;
            this._keyHeight = keyHeight;
            for (const key of this._keyHeights) {
                key.height = keyHeight;
                key.style = `font-size: ${fontSize}px;`;
            }
            this._englishKeyRows.forEach((row, index) => {
                const spare = Math.floor(this._englishExtra / 4) +
                    (index < this._englishExtra % 4 ? 1 : 0);
                for (const key of row.get_children()) {
                    key.height = keyHeight + spare;
                    key.style = `font-size: ${Math.min(fontSize, 20)}px;`;
                }
            });
        }
        this._layoutSpellings(contentWidth);
        this._layoutCandidates(contentWidth);
        const [, height] = this._panel.get_preferred_height(width);
        const pos = this._layout.position;
        const x = clamp(pos?.x ?? monitor.x + (monitor.width - width) / 2,
            monitor.x + 8, monitor.x + monitor.width - width - 8);
        const defaultY = this._layout.atTop ? monitor.y + 44 : monitor.y + monitor.height - height - 24;
        const y = clamp(anchorTop ?? (pos ? pos.bottom - height : defaultY),
            monitor.y + 36, monitor.y + monitor.height - height - 8);
        this._panel.set_position(Math.round(x), Math.round(y));
        if (this._minimized) {
            this._restoreButton.set_position(
                Math.round(clamp(x + width - RESTORE_SIZE, monitor.x + 8,
                    monitor.x + monitor.width - RESTORE_SIZE - 8)),
                Math.round(clamp(y + height - RESTORE_SIZE, monitor.y + 36,
                    monitor.y + monitor.height - RESTORE_SIZE - 8)));
        }
        if (anchorTop !== null)
            this._layout.position = {x, bottom: y + height};
    }

    _connectGrip(grip, type) {
        grip.connect('button-press-event', (_actor, event) =>
            event.get_button() === 1 ? this._startDrag(type, event) : Clutter.EVENT_PROPAGATE);
        grip.connect('touch-event', (_actor, event) => event.type() === Clutter.EventType.TOUCH_BEGIN
            ? this._startDrag(type, event) : Clutter.EVENT_PROPAGATE);
    }

    _startDrag(type, event) {
        if (this._drag || (this._layout.widthLocked && (type === 'left' || type === 'right')))
            return Clutter.EVENT_STOP;
        const [x, y] = event.get_coords();
        const [left, top] = this._panel.get_position();
        this._drag = {type, x, y, left, top, bottom: top + this._panel.height,
            width: this._panel.width, keyHeight: this._keyHeight, monitor: this._currentMonitor(),
            slot: event.get_event_sequence()?.get_slot(), device: event.get_source_device(), moved: false};
        this._dragSignal = global.stage.connect('captured-event', (_stage, current) => this._dragEvent(current));
        this._armDragTimeout();
        return Clutter.EVENT_STOP;
    }

    _armDragTimeout() {
        if (this._dragTimer)
            GLib.source_remove(this._dragTimer);
        this._dragTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
            this._dragTimer = 0;
            this._finishDrag();
            return GLib.SOURCE_REMOVE;
        });
    }

    _dragEvent(event) {
        const drag = this._drag;
        if (event.get_source_device() !== drag.device || event.get_event_sequence()?.get_slot() !== drag.slot)
            return Clutter.EVENT_PROPAGATE;
        const type = event.type();
        const moving = type === Clutter.EventType.MOTION || type === Clutter.EventType.TOUCH_UPDATE;
        const released = type === Clutter.EventType.TOUCH_END ||
            (type === Clutter.EventType.BUTTON_RELEASE && event.get_button() === 1);
        if (moving || released) {
            const [x, y] = event.get_coords();
            const dx = x - drag.x;
            const dy = y - drag.y;
            if (drag.moved || Math.hypot(dx, dy) >= 3) {
                drag.moved = true;
                if (drag.type === 'move') {
                    const monitor = Main.layoutManager.monitors.find(m =>
                        x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height) ?? drag.monitor;
                    this._layout.position = {x: drag.left + dx, bottom: drag.bottom + dy};
                    this._place(monitor);
                } else {
                    this._resizeFromEdge(drag, dx, dy);
                }
            }
            if (moving)
                this._armDragTimeout();
        }
        if (released || type === Clutter.EventType.TOUCH_CANCEL)
            this._finishDrag();
        return moving || released || type === Clutter.EventType.TOUCH_CANCEL
            ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
    }

    _resizeFromEdge(drag, dx, dy) {
        const {type, monitor, left, top, bottom, width, keyHeight} = drag;
        if (type === 'left' || type === 'right') {
            const fromLeft = type === 'left';
            const target = width + (fromLeft ? -dx : dx);
            const available = fromLeft ? left + width - monitor.x - 8
                : monitor.x + monitor.width - left - 8;
            this._layout.width = Math.round(clamp(target, MIN_WIDTH, Math.min(MAX_WIDTH, available)));
            this._layout.keyHeight = keyHeight;
            this._layout.position = {x: fromLeft ? left + width - this._layout.width : left, bottom};
            this._place(monitor);
            return;
        }

        const delta = type === 'top' ? -dy : dy;
        this._layout.keyHeight = Math.round(clamp(keyHeight + delta / 4, MIN_KEY_HEIGHT, MAX_KEY_HEIGHT));
        this._layout.position = {x: left, bottom};
        this._place(monitor, type === 'bottom' ? top : null);
    }

    _finishDrag() {
        const drag = this._drag;
        if (!drag)
            return;
        this._drag = null;
        global.stage.disconnect(this._dragSignal);
        this._dragSignal = 0;
        if (this._dragTimer)
            GLib.source_remove(this._dragTimer);
        this._dragTimer = 0;
        if (drag.moved) {
            const [x, y] = this._panel.get_position();
            const [, height] = this._panel.get_preferred_height(this._panel.width);
            this._layout.position = {x, bottom: y + height};
            this._saveLayout();
        }
    }

    _layoutSpellings(width) {
        if (!this._spellingRow.visible)
            return;
        const buttons = this._spellingButtons.filter(button => button.visible);
        const gap = 4;
        const controls = [this._moreSpellings, this._correctionButton].filter(button => button.visible);
        const controlWidth = controls.reduce((sum, button) => sum + button.get_preferred_width(-1)[1], 0);
        const available = width - gap * (buttons.length + controls.length + Number(this._preedit.visible)) -
            controlWidth - 1;
        if (this._preedit.visible) {
            this._preedit.width = Math.max(30, available);
            this._preedit.clutter_text.width = this._preedit.width - 6;
        }
        if (!buttons.length)
            return;
        const desired = buttons.map(button => Math.max(38, button.get_child().text.length * 8 + 12));
        const goal = desired.reduce((sum, value) => sum + value, 0);
        const minimum = Math.floor(Math.min(38, available / buttons.length));
        const stretch = Math.min(1, (available - minimum * buttons.length) /
            Math.max(1, goal - minimum * buttons.length));
        buttons.forEach((button, index) => {
            const slot = minimum + Math.floor((desired[index] - minimum) * stretch);
            button.width = slot;
            const label = button.get_child();
            label.width = slot - 10;
            label.clutter_text.width = label.width;
        });
    }

    _layoutCandidates(width) {
        const candidates = this._candidateButtons.filter(({button}) => button.visible);
        if (!candidates.length)
            return;
        const arrows = [this._previous, this._next].filter(button => button.visible);
        const arrowWidth = arrows.reduce((sum, button) => sum + button.get_preferred_width(-1)[1], 0);
        const available = width - 4 * (candidates.length + arrows.length) - arrowWidth - 1;
        const lengths = candidates.map(({label}) => Array.from(label.text).length);
        // Reserve enough width for each word on one line whenever the row fits.
        // With longer phrases, let the labels wrap at character boundaries.
        const desired = lengths.map(length => Math.max(42, length * 16 + 12));
        const minimum = Math.min(42, Math.floor(available / candidates.length));
        const room = available - minimum * candidates.length;
        const target = desired.reduce((total, value) => total + value - minimum, 0);
        const scale = Math.min(1, room / Math.max(1, target));
        candidates.forEach(({button, label}, index) => {
            const slot = minimum + Math.floor((desired[index] - minimum) * scale);
            button.width = slot;
            label.width = slot - 10;
            label.clutter_text.width = label.width;
        });
    }

    _warmEngine() {
        if (this._engine)
            return;
        try {
            this._engine = new Engine(GLib.build_filenamev([this.path, 'engine']));
        } catch (error) {
            console.error(error);
        }
    }

    _setMode(mode) {
        this._englishExtra = 0;
        this._mode = mode;
        this._state = EMPTY;
        this._clearChoice();
        this._error = '';
        if (this._engine)
            return this._engine.send('clear');
    }

    _toggleLanguage() {
        this._shift = false;
        if (this._language === 'english') {
            this._language = 'pinyin';
            this._englishExtra = 0;
        } else {
            this._language = 'english';
            this._englishExtra = this._suggestions.visible
                ? Math.round(this._suggestions.height) + 7 : 0;
        }
        this._mode = this._language;
    }

    _reset() {
        ++this._generation;
        this._queue = [];
        this._state = EMPTY;
        this._englishExtra = 0;
        this._shift = false;
        this._clearChoice();
        this._error = '';
        if (this._panel.visible)
            this._render();
        if (this._engine)
            this._act('reset');
    }

    _clearChoice() {
        this._choice = null;
        this._spellingPage = 0;
        this._viewPage = 0;
    }

    _choose(choice) {
        this._choice = choice;
        this._viewPage = 0;
        this._render();
    }

    _render() {
        const state = this._state;
        const pinyin = this._mode === 'pinyin';
        const english = this._mode === 'english';
        this._chineseKeys.visible = !english;
        this._englishKeys.visible = english;
        for (const {button, char} of this._englishLetters) {
            const label = this._shift ? char.toUpperCase() : char;
            button.label = label;
            button.accessible_name = label;
        }
        if (this._shift)
            this._shiftKey.add_style_pseudo_class('selected');
        else
            this._shiftKey.remove_style_pseudo_class('selected');
        const spellings = [...new Set(state.alternatives.map(item => cleanPinyin(item.pinyin)).filter(Boolean))];
        this._spellingPageCount = Math.max(1, Math.ceil(spellings.length / SPELLINGS_PER_PAGE));
        this._spellingPage = Math.min(this._spellingPage, this._spellingPageCount - 1);
        const start = this._spellingPage * SPELLINGS_PER_PAGE;
        this._shownSpellings = spellings.slice(start, start + SPELLINGS_PER_PAGE);
        const choosingCorrection = this._choice === CORRECTION;
        this._spellingButtons.forEach((button, index) => {
            const spelling = pinyin && !choosingCorrection ? this._shownSpellings[index] : '';
            button.get_child().text = spelling ?? '';
            button.accessible_name = spelling || '拼音候选';
            button.visible = Boolean(spelling);
            button.reactive = button.visible;
            if (spelling && spelling === this._choice)
                button.add_style_pseudo_class('selected');
            else
                button.remove_style_pseudo_class('selected');
        });
        this._moreSpellings.visible = pinyin && !choosingCorrection && this._spellingPageCount > 1;
        this._moreSpellings.reactive = this._moreSpellings.visible;
        const exactTexts = new Set(state.alternatives.filter(item =>
            pinyinCode(cleanPinyin(item.pinyin)) === state.input.replaceAll("'", '')).map(item => item.text));
        const corrections = state.corrections.filter(item => !exactTexts.has(item.text));
        this._correctionButton.visible = pinyin && (choosingCorrection || corrections.length > 0);
        this._correctionButton.reactive = this._correctionButton.visible;
        this._correctionButton.label = this._choice === CORRECTION ? '返回' : '纠错';
        if (this._choice === CORRECTION)
            this._correctionButton.add_style_pseudo_class('selected');
        else
            this._correctionButton.remove_style_pseudo_class('selected');

        let filtered = null;
        if (this._choice === CORRECTION)
            filtered = corrections.map(candidate => ({...candidate, corrected: true}));
        else if (this._choice)
            filtered = state.alternatives.filter(item => cleanPinyin(item.pinyin) === this._choice);

        const offset = this._viewPage * this._candidateButtons.length;
        this._shown = filtered ? filtered.slice(offset, offset + this._candidateButtons.length)
            : state.candidates.map((candidate, index) => ({...candidate, pageIndex: index}));
        if (!pinyin)
            this._shown = [];
        this._previous.reactive = pinyin && (filtered ? this._viewPage > 0 : state.page > 0);
        this._next.reactive = pinyin && (filtered ? offset + this._candidateButtons.length < filtered.length
            : state.candidates.length > 0 && !state.last);
        this._previous.visible = this._previous.reactive;
        this._next.visible = this._next.reactive;

        const letters = cleanPinyin(this._shown[0]?.pinyin);
        const unconverted = Array.from(state.input, char => {
            if (char === "'" || char === '1')
                return "'";
            return LETTERS[Number(char)]?.toLowerCase() || char.replace(/[^a-zü]/gi, '');
        }).join(' ');
        // The spelling buttons already show the reading during ordinary input.
        this._preedit.text = this._error || letters || unconverted;
        this._preedit.visible = Boolean(this._error) ||
            (pinyin && Boolean(state.input) && (choosingCorrection || !this._shownSpellings.length));
        this._spellingRow.visible = this._preedit.visible ||
            this._correctionButton.visible || this._spellingButtons.some(button => button.visible);
        this._wordRow.visible = this._shown.length > 0;
        this._suggestions.visible = this._spellingRow.visible || this._wordRow.visible;
        this._candidateButtons.forEach(({button, label}, i) => {
            const candidate = this._shown[i];
            label.text = candidate?.text ?? '';
            if (candidate?.corrected)
                button.add_style_pseudo_class('corrected');
            else
                button.remove_style_pseudo_class('corrected');
            button.accessible_name = candidate?.corrected
                ? `${candidate.text}，${candidate.pinyin}，纠错候选` : candidate?.text ?? '';
            button.visible = Boolean(candidate);
            button.reactive = button.visible;
            if (i === 0 && candidate)
                button.add_style_pseudo_class('first');
            else
                button.remove_style_pseudo_class('first');
        });
        for (const {digit, button, caption, number} of this._keys) {
            const face = this._mode === 'symbol' ? SYMBOLS[digit] :
                pinyin ? LETTERS[digit] : String(digit);
            caption.text = face;
            number.visible = pinyin && digit !== 0;
            button.accessible_name = number.visible ? `${digit} ${face}` : face;
        }
        this._clearKey.label = this._mode === 'number' ? '0' : '清空';
        this._clearKey.accessible_name = this._clearKey.label;
        this._modeKey.label = pinyin ? '123' : this._language === 'english' ? 'ABC' : '九键';
        this._modeKey.accessible_name = pinyin ? '切换数字键盘' : '返回字母键盘';
        this._languageKey.label = this._language === 'english' ? '中' : '英';
        this._languageKey.accessible_name = this._language === 'english' ? '切换中文九宫格' : '切换英文键盘';
        this._symbolsKey.label = this._mode === 'symbol' ? (this._language === 'english' ? 'ABC' : '中') : '符号';
        this._symbolsKey.accessible_name = this._mode === 'symbol' ? '返回字母键盘' : '切换符号键盘';
        if (this._panel.visible)
            this._place();
    }

    _act(action, value) {
        this._queue.push({action, value, generation: this._generation});
        if (!this._running)
            this._drain();
    }

    async _drain() {
        this._running = true;
        while (this._queue.length && this._panel) {
            const {action, value, generation} = this._queue.shift();
            try {
                await this._handle(action, value, generation);
            } catch (error) {
                if (generation !== this._generation)
                    continue;
                console.error(error);
                this._engine?.close();
                this._engine = null;
                this._state = EMPTY;
                this._error = '九键词库加载失败';
            }
            if (generation === this._generation && this._panel.visible)
                this._render();
        }
        this._running = false;
    }

    async _handle(action, value, generation) {
        const {input, candidates, page, last} = this._state;
        let command;
        let picked;
        switch (action) {
        case 'language':
            this._toggleLanguage();
            return;
        case 'mode':
            return this._setMode(value);
        case 'shift':
            this._shift = !this._shift;
            return;
        case 'english-text': {
            const text = this._shift ? value.toUpperCase() : value;
            this._shift = false;
            let letters = text;
            if (!Main.inputMethod.currentFocus) {
                while (this._queue[0]?.action === 'english-text' && this._queue[0].generation === generation)
                    letters += this._queue.shift().value;
            }
            return this._commit(letters);
        }
        case 'digit':
            if (this._mode === 'symbol')
                return this._commit(SYMBOLS[value]);
            if (this._mode === 'number')
                return this._keyval(Clutter.KEY_0 + value);
            if (value === 1 && !input)
                return;
            this._clearChoice();
            command = value === 1 ? 'split' : String(value);
            break;
        case 'back':
            if (this._mode === 'english' || !input)
                return this._keyval(Clutter.KEY_BackSpace);
            this._clearChoice();
            command = 'back';
            break;
        case 'space':
        case 'enter':
            if (this._mode === 'english' || !input)
                return this._keyval(action === 'space' ? Clutter.KEY_space : Clutter.KEY_Return);
            picked = this._shown[0];
            break;
        case 'pick':
            if (value.state !== this._state || !this._shown.includes(value.candidate))
                return;
            picked = value.candidate;
            break;
        case 'punctuation':
            if (!input)
                return this._commit(value);
            if (this._choice && this._shown[0])
                picked = this._shown[0];
            else
                command = 'finish';
            break;
        case 'next':
        case 'previous':
            if (this._choice) {
                if ((action === 'next' ? this._next : this._previous).reactive)
                    this._viewPage += action === 'next' ? 1 : -1;
                return;
            }
            if (!candidates.length || (action === 'next' ? last : page === 0))
                return;
            command = action;
            break;
        case 'reset':
        case 'clear':
            if (!this._engine)
                return;
            this._clearChoice();
            command = 'clear';
            break;
        }

        if (picked) {
            if (picked.corrected)
                command = 'clear';
            else if (picked.index !== undefined)
                command = `select ${picked.index}`;
            else
                command = `pick ${picked.pageIndex}`;
            this._clearChoice();
        }
        if (!command)
            return;

        this._engine ??= new Engine(GLib.build_filenamev([this.path, 'engine']));
        let state = await this._engine.send(command);
        if (action === 'punctuation' && state.input && generation === this._generation) {
            const remaining = await this._engine.send('finish');
            state = {...remaining, commit: state.commit + remaining.commit};
        }
        if (generation !== this._generation)
            return;
        this._state = state;
        this._error = '';
        const text = (picked?.corrected ? picked.text : state.commit) + (action === 'punctuation' ? value : '');
        if (text) {
            this._render();
            await this._commit(text);
        }
    }

    _keyval(keyval) {
        const time = Clutter.get_current_event_time();
        this._device.notify_keyval(time, keyval, Clutter.KeyState.PRESSED);
        this._device.notify_keyval(time, keyval, Clutter.KeyState.RELEASED);
    }

    async _commit(text) {
        if (Main.inputMethod.currentFocus) {
            Main.inputMethod.commit(text);
            return;
        }
        if (!global.display.focus_window)
            return;

        // XWayland and clients without Wayland text-input receive a paste.
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        const time = Clutter.get_current_event_time();
        this._device.notify_keyval(time, Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
        this._keyval(Clutter.KEY_v);
        this._device.notify_keyval(time, Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
        await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        }));
    }
}
