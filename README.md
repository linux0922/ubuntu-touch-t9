# Ubuntu Touch T9 · 九宫格拼音触控键盘

适合 Ubuntu 平板的浮动屏幕键盘，提供中文九宫格、英文 QWERTY 和数字、符号页。扩展通过 GNOME 快速设置开关，在当前应用的文本框上屏。中文候选和纠错在本机计算。

## 适用环境和输入法

- 实测环境为 Ubuntu 26.04.1 LTS、GNOME Shell 50.1、Wayland、ARM64。其它架构可本地编译。
- 配套输入法为 [Fcitx 5 的 Rime（中州韵）插件](https://github.com/fcitx/fcitx5-rime) + [雾凇拼音（Rime Ice）](https://github.com/iDvel/rime-ice) 自带的「中文九键」方案 `t9`。
- 屏幕键盘直接调用系统的 librime，读取 Fcitx 5 的 Rime 目录并选用 `t9`。实体键盘仍可在 Fcitx 5 使用雾凇全拼或平时选用的其它方案。
- 默认 Rime 目录为 `~/.local/share/fcitx5/rime`。设置了 `XDG_DATA_HOME` 时，扩展读取该目录下的 `fcitx5/rime`。
- 上屏优先走 GNOME 的原生文本输入。需要用粘贴上屏的应用会替换当前剪贴板文本。

## 安装

### 1. 安装 Fcitx 5、Rime 和构建工具

```sh
sudo apt update
sudo apt install git build-essential zip fcitx5 fcitx5-config-qt fcitx5-rime librime-dev librime-bin librime-plugin-lua
```

### 2. 安装并部署雾凇拼音

全新配置可执行以下命令。已有 Rime 配置时，先备份，再按照上游安装指南合并雾凇拼音文件，并在现有 `schema_list` 中启用 `rime_ice` 和 `t9`。 [雾凇拼音安装指南](https://github.com/iDvel/rime-ice/blob/main/others/docs/Installation.md)

```sh
rime_dir="${XDG_DATA_HOME:-$HOME/.local/share}/fcitx5/rime"
mkdir -p "$(dirname "$rime_dir")"
if [ ! -e "$rime_dir" ]; then
  git clone --depth 1 https://github.com/iDvel/rime-ice.git "$rime_dir"
else
  printf 'Rime 目录已存在，请按上面的指南合并雾凇拼音配置。\n'
fi
```

打开 **Fcitx 5 配置**（`fcitx5-configtool`），在输入法列表添加 **Rime / 中州韵**。如需设置实体键盘的默认输入法框架，可在 Ubuntu 的「语言支持」中选用 Fcitx 5。然后在 Rime 菜单选择「重新部署」，或运行下列部署命令。部署后检查生成的文件。

```sh
rime_dir="${XDG_DATA_HOME:-$HOME/.local/share}/fcitx5/rime"
rime_deployer --build "$rime_dir" /usr/share/rime-data "$rime_dir/build"
ls "$rime_dir/build/t9.schema.yaml" "$rime_dir/build/t9.prism.bin" \
   "$rime_dir/build/rime_ice.table.bin"
```

### 3. 构建并安装扩展

```sh
git clone https://github.com/linux0922/ubuntu-touch-t9.git
cd ubuntu-touch-t9
make
gnome-extensions install --force build/ubuntu-touch-t9.shell-extension.zip
```

注销并重新登录一次，让 GNOME Shell 识别新装或更新的扩展。然后在「扩展」应用启用「九宫格拼音」，或运行：

```sh
gnome-extensions enable ubuntu-touch-t9@codex.local
```

## 使用方法

1. 点进要输入的文本框，再打开右上角 **快速设置 → 九宫格拼音**。
2. 按 `6 4 4 2 6`，点「你好」上屏。**空格**选首词，**分词**插入音节分隔，点候选上方的拼音可以按读音筛选。长词会在候选区内换行。
3. 错按、漏按或多按一个键时，可点「纠错」查看建议。例如把 `64426` 漏按成 `6446`，可以在纠错候选里找「你好」。
4. 底排 **英** 切到 QWERTY，点 **中** 返回；第三排最右侧 **符号** 打开符号页；**123** 打开数字页。
5. 拖标题栏可以移动。拖上下边缘改高度；如要改宽度，先在 **⚙ → 锁定宽度** 里解锁，再拖左右边缘。设置里也能调 **50%–100% 不透明度**。
6. 点顶部 **▁** 最小化，点浮动的小键盘图标恢复。点 **×** 关闭，可从快速设置重新打开。

## 排查和卸载

- **快速设置里没有九宫格拼音**：确认当前会话为 Wayland（`echo "$XDG_SESSION_TYPE"`），且扩展已启用（`gnome-extensions info ubuntu-touch-t9@codex.local`）。
- **提示九键词库加载失败**：核对 `t9.schema.yaml`、`t9.prism.bin`、`rime_ice.table.bin` 的部署路径，再检查 GNOME Shell 日志（`journalctl -b _COMM=gnome-shell`）。
- **没有纠错候选**：纠错使用雾凇拼音的 `cn_dicts/base.dict.yaml`，请核对该文件是否位于 Rime 目录，并用 `6446` 复测。
- **卸载**：运行 `gnome-extensions disable ubuntu-touch-t9@codex.local`，再运行 `gnome-extensions uninstall ubuntu-touch-t9@codex.local`。扩展的位置和外观保存在 `${XDG_STATE_HOME:-$HOME/.local/state}/ubuntu-touch-t9/layout.json`。

## 源码与上游

`extension.js` 和 `minimizable-keyboard.js` 为 GNOME Shell 扩展，`engine.c` 和 `correction.c` 分别负责 Rime 会话与纠错。构建时从系统链接 librime，词库按上文单独安装。 [librime](https://github.com/rime/librime) · [雾凇拼音](https://github.com/iDvel/rime-ice)
