<div align="center">

<img src="assets/icon.png" width="132" alt="Snap 截图" />

# Snap 截图

**macOS 截图工具 · 微信桌面端截图同款交互**

按 `⌃⌘A` 随时截图：整屏冻结变暗 → 智能识别窗口/控件 → 拖拽框选 → 放大镜取色 → 六种标注 → 复制 / 保存 / 钉在屏幕上。

菜单栏常驻，不占 Dock 栏。Intel 与 Apple 芯片通用。

</div>

![选区与工具栏](assets/screenshot-select.png)

![标注](assets/screenshot-annotate.png)

---

## 下载安装

从 [Releases](../../releases) 下载 **`Snap-1.0.0-mac-universal.dmg`**（Intel + Apple 芯片通用，推荐）
或 `Snap-1.0.0-mac-universal.zip`，校验收据见同页 `SHA256SUMS.txt`。

安装：打开 dmg，把 **Snap 截图.app** 拖进 `应用程序`。

> 应用没有 Apple 开发者签名，首次打开会被 Gatekeeper 拦住。任选一种方式放行：
> - 在 `应用程序` 里 **右键 → 打开**，再点“打开”；
> - 或执行一次：`xattr -dr com.apple.quarantine "/Applications/Snap 截图.app"`
>
> 建议移动/复制到 `/Applications` 再打开，这样“开机自动启动”才能被系统正确登记。

### 首次授权（重要）

1. **屏幕录制**：第一次按 ⌃⌘A 时系统会弹窗，去
   `系统设置 → 隐私与安全性 → 屏幕录制` 勾选 **Snap 截图**，然后**重新启动应用**。
   未授权时截图只能看到桌面壁纸。
2. **辅助功能**（可选，用于“智能识别”）：勾选后光标下的**按钮、文字等控件**会被精确高亮；
   未授权时只能识别到整扇窗口。路径：`系统设置 → 隐私与安全性 → 辅助功能`。

应用内点菜单栏图标 → “使用说明 / 设置…”，可以直接跳到这两个面板并查看授权状态。

---

## 功能

**截图**
- 全局快捷键 ⌃⌘A（`SNAP_HOTKEY` 环境变量可改）
- 多显示器：每块屏都能框选，鼠标所在屏优先响应
- 智能识别：光标悬停即高亮整窗；装了辅助功能权限后精确到控件，单击即选中
- 拖拽框选，8 个控制点微调，方向键 1px / Shift+方向键 10px 微调
- 放大镜跟随光标：像素级放大、坐标、取色（HEX）、实时尺寸
- 选区尺寸气泡、选区边框与控制点跟随当前标注颜色
- ⇧ 拖拽 = 正方形 / 正圆 / 45° 箭头

**标注**（默认红色，可换 8 色 + 4 档粗细）
- 矩形、椭圆、箭头、画笔（平滑曲线）、马赛克（真实像素化，块大小 10pt）、文字
- 撤销 / 重做，标注被裁剪在选区内，导出时按原生分辨率重新渲染（不含 UI）

**输出**
- 复制到剪贴板（⌘C / ⏎ / 双击选区）
- 保存 PNG（⌘S），默认存到 `~/图片/Snap截图_20251017094113.png`，保存后在访达中显示
- 钉在屏幕：贴图窗口可拖动，滚轮缩放（等比）、⌘+滚轮调透明度、双击 / Esc 关闭、右键菜单

**菜单栏**
- **保持屏幕常亮（不息屏）**：勾选后调用 `powerSaveBlocker('prevent-display-sleep')`，
  桌面不再息屏/睡眠；设置持久化，下次启动自动生效
- **开机自动启动**：登录后自动后台运行（macOS 13+ 若提示“需要允许”，到
  `系统设置 → 通用 → 登录项` 打开）
- 权限状态一键跳转、打开使用说明、退出

**快捷键一览**

| 操作 | 快捷键 |
| --- | --- |
| 截图 | ⌃⌘A |
| 复制并退出 | ⌘C 或 ⏎ |
| 保存 PNG | ⌘S |
| 撤销 / 重做 | ⌘Z / ⇧⌘Z |
| 全屏选区 | ⌘A |
| 开关键盘智能识别 | A 或 Tab |
| 返回上一步 / 取消 | Esc（逐级：文字 → 工具 → 选区 → 退出） |
| 重新框选 | 在选区外按下拖动 |
| 移动选区 | 在选区内拖动 |
| 文字工具：换行 / 提交 | ⇧⏎ / ⏎ |

---

## 从源码运行

```bash
npm install                 # Electron 44
npm run helper              # 编译原生 hit-test helper（需要 Xcode 命令行工具）
npm start                   # 开发模式运行
npm run selftest            # 无权限依赖的自检：53 项断言 + 截图
npm run bundle              # 打包 x64 / arm64 / universal → dist/
```

开发模式运行时，屏幕录制权限归属于 **Electron**（而不是打包后的 Snap）。

### 自检

`npm run selftest` 用合成桌面（不需要屏幕录制权限）驱动真实 UI：
`webContents.sendInputEvent` 模拟鼠标键盘，逐项校验智能识别、选区、每个工具是否真的
改变了导出图片的像素、马赛克块是否真的按 10pt 网格一致、剪贴板与保存文件的分辨率等等，
并把每个阶段的截图写到 `build/test-out/`。

---

## 结构

```
src/main.js              主进程：快捷键、多屏抓屏、覆盖窗口、剪贴板/保存/贴图、托盘、权限
src/renderer/overlay.js  选区状态机、放大镜、工具栏、键盘、导出
src/renderer/ops.js      标注模型与渲染（含马赛克像素化、合成导出）
src/renderer/pin.*       贴图窗口
src/renderer/help.*      使用说明 / 设置（含常亮与开机启动开关）
src/winlist.swift        原生 helper：CGWindowList + AX 命中测试（stdin/stdout JSON）
scripts/build-app.sh     打包 x64 + arm64 + universal，产出 zip/dmg 与校验和
scripts/build-helper.sh  编译 x86_64 + arm64 并 lipo 成通用 helper
scripts/make-icon.js     用 canvas 渲染 AppIcon.icns
scripts/run-selftest.js  运行应用内自检
```

坐标系约定：所有标注都用“显示器 DIP 坐标”存储，屏幕渲染时按 `devicePixelRatio`
放大、导出时按“抓屏图素 / DIP”放大，因此同一份标注在预览与导出中完全一致。

## 已知差异（与微信截图相比）

- 视觉细节是仿制而非像素级复刻（工具栏图标、配色为手绘近似）
- 没有 OCR 取字 / 翻译按钮
- 不支持跨显示器一次性框选（每块屏各自框选）
- 未做 Apple 公证：首次打开需要右键放行

## License

MIT
