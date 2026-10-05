# 小部件设计工具（网页版）

左边写脚本、右边立刻看到小组件长什么样。不用装 Gradle、不用 adb、不用等桌面刷新。

- **在线直接用**：<https://lswlc33.github.io/HyperWidgetMarket/studio/>（Chrome / Edge；Firefox/Safari 只能只读打开）
- 需求 Chrome / Edge —— 用 File System Access 直接读写你的脚本目录
- 设计文档与保真度口径：App 仓库的 `docs/网页设计工具计划.md`

## 怎么用

1. **打开文件夹**：选手机同步过来的 `Download/HyperWidget/`（或任意脚本目录）。工具按 App 的目录约定工作：
   根目录 `*.js` + **同名资源文件夹**（`test1.js` ↔ `test1/`，含 `cache/`）。
   用在线版时页面只读你的本地目录，**脚本不会上传**。
2. **选脚本**：左栏点一下，或顶栏下拉框。元数据（NAME/VERSION/SIZES）按 App 的静态扫描规则解析。
3. **改代码**：输入停 400ms 自动重跑（`实时` 开关可关）；`Ctrl+Enter` 立刻跑，`Ctrl+S` 保存
   （保存时按 App 的规则自动维护 `UPDATED_AT`）。
4. **看预览**：右上切换 2×2 / 4×2 / 4×4（只显示脚本 `SIZES` 里声明过的档位）；☾ 切换深色 = 宿主切深色。
5. **点画布**：点带 `tap` 的节点会提示"这一下在桌面上会发生什么"（不会真的跳转）。
6. **造数据**：右下「数据」页改电量/充电/设备型号/画布尺寸；「变量」页改 `PRESETS`（`ctx.env`）与
   `GLOBALS`（`ctx.global`）；mock 表可以塞接口返回值与命令输出（`http:URL` / `httpbin:URL` / `shell:命令`）。
7. **资源**：左栏「资源」列出当前脚本文件夹里的文件，点开可看大图、一键插入 `ui.image({ path: "图标.png" })`。
   真机下载过的在线图在 `cache/` 里也能直接看到（缓存文件名与 App 的规则一致）。

## 主题从哪来（三态）

界面上「数据」页第一行会显示当前来源：

| 来源 | 什么时候 | 说明 |
|---|---|---|
| **仓库直读** | 本地用 `serve.py --app <App 仓库>` 打开 | 直接读 App 的 `res/` 与 `assets/widget-ui.js`，改令牌/图标/组件库刷新即见 |
| **主题快照** | 在线版（GitHub Pages），或本地没挂 App 仓库 | 用提交在本仓库的 `js/theme.generated.js`（令牌、19 图标、drawable、内置图、组件库全文） |
| **内置兜底** | 上面两者都没读到（异常） | 只有 5 个颜色常量，图标与 `ui.*` 不可用，顶栏会飘红 |

直读模式下某个文件 404 时，会用快照里的对应项补齐（不缺项不降级）。

## 本地跑 / 本地开发

```bash
python serve.py 8611                            # 用主题快照（不需要 App 仓库）
python serve.py 8611 --app ../pa-widget-hook    # 直读 App 仓库（改 res/ 立刻生效）
# → http://127.0.0.1:8611/studio/
```

Windows 上双击 `serve.cmd`（可带参数：`serve.cmd 8611 D:\code\pa-widget-hook`）。

**为什么必须走服务器**：`file://` 页面创建不了 Web Worker（脚本执行要放 worker 里才能 8 秒超时强杀），
也读不到同目录资源；而且目录读写（File System Access）在 `file://` 下不可靠。
`serve.py` 不带任何业务逻辑，只是把文件发出去，并且一律 `no-store`（改完刷新即见）。

## 改过 App 资源之后：重跑主题快照

```bash
node tools/sync-studio-assets.mjs --app <App 仓库路径>           # 生成 studio/js/theme.generated.js
node tools/sync-studio-assets.mjs --app <App 仓库路径> --check   # 只比对（不一致退出 1）
node tools/check-studio.mjs && node studio/test-engine.js        # CI 同款两项检查
```

**忘了跑会怎样**：在线版的令牌/图标/组件库停留在旧版本，而 CI 查不出来（CI 读不到私有的 App 仓库）。
所以界面「数据」页会显示快照的来源版本（`App@<sha> · 日期`），对不上就说明该重跑了。

## 改脚本时会主动提醒你的事

- **`stack`/`box` 是 FrameLayout**：多个子项会**叠**在左上角。`ui.card([a, b, c])` 也是这个坑（card 就是 box）。
- **`w:"match"` 在 box/stack 里**：只有 box/stack 自身尺寸确定时才有宽度；不确定时退回 wrap_content，工具会提醒。
- **内容超出安全区**：渲染后实测高度差，超了就报"内容比安全区高 Ndp，桌面会被裁"。
- **行内 `w:"match"` 只能写在最后一个子项**、`gravity` 只有 column/row 支持、节点 ≤80 / 深度 ≤6：
  这些在 App 里是解析期报错，工具里给的是**同一句中文报错**并标行号。
- **Rhino 兼容**：`?.`、`??`、`.flat()`、`Intl`、`async` 等在设备上会直接报错，工具统一给"疑似"告警。

## 调试入口（F12 控制台）

```js
HW.studio.getCode()                                                  // 当前脚本源码
HW.studio.setCode("function render(ctx){ return { title: 'hi' } }")  // 灌源码并立刻重跑
HW.studio.run()                                                      // 重跑
HW.studio.settings                                                   // 已持久化的设置
HW.theme.sourceLabel()                                               // 主题来源（直读/快照/兜底）
```

## 一定要知道的差异（工具 ≠ 真机）

| 差异 | 说明 |
|---|---|
| **引擎不同** | 浏览器是 V8，设备上是 **Rhino**（ES6 子集、解释执行）。工具会扫出"疑似不支持"的写法，但**最终判据永远是真机** |
| 字体排版 | 行高按 1.32em 近似（Android 含 font padding），字宽有残差；"会不会溢出"这类结论请以真机为准 |
| 宿主主题 | 桌面上 RemoteViews 按 `com.miui.home` 的主题 inflate（`?attr/...` 曾把进度条解析成 4 倍粗）。工具里是固定样式 |
| launcher 圆角/阴影 | 桌面自己裁的，工具只画 `widget_bg` 的 20dp 圆角 |
| 桌面画布 | 用真机上报值（4×2 = 350×166、4×4 = 350×365）；桌面实际绘制还比上报值小一圈，别把内容顶到边缘 |
| 大图合成 | `paneltop/fade/round/corner/panelinset` 按 `WidgetImageService` 逐行复刻 |
| 网络 | 设备侧是同步阻塞 + 8 秒超时；工具用同步 XHR（worker 里）。CORS 会挡住一部分接口，用 mock 表或代理前缀 |
| `shell` | 网页里不可能真的执行；没配 mock 就返回空串并在控制台标 ⚠ |
| 经典字段的 rows | 工具按**桌面行为**裁行（高度 190→4 / 120→3 / 否则 2）；应用内预览不裁 |
| https 页面 | 在线版是 https，脚本里调 **http** 接口会被浏览器的混合内容策略拦（本地 http 打开时正常） |

改完记得回真机走一遍：

```bash
adb exec-out content read --uri "content://io.github.lswlc33.hyperwidget.preview/4x4?script=脚本名.js" > out.png
```

## 离线 / 内网

- **Monaco（编辑器内核）**默认从 CDN 取，顺序：`vendor/monaco`（本地）→ `registry.npmmirror.com` →
  jsdelivr → fastly.jsdelivr → unpkg；每个源最多等 5 秒，全失败退回纯文本编辑（预览/保存照常）。
  要完全离线：把 `monaco-editor/min` 放到 `studio/vendor/monaco/`（即 `vendor/monaco/vs/loader.js` 存在即可）。
- 主题快照已随仓库提交，因此**不需要 App 仓库**也能完整使用在线版。

## 快捷键

| 操作 | 说明 |
|---|---|
| `Ctrl+S` | 保存（自动维护 `UPDATED_AT`） |
| `Ctrl+Enter` | 立刻重跑脚本 |
| Ctrl/Alt + 点「打开文件夹」 | 用只读方式打开（`<input webkitdirectory>`，Firefox/Safari 的入口） |
| 顶栏「实时」 | 关掉后只在 `Ctrl+Enter` / 点「运行」时重跑 |
| 脚本执行超时 | 8 秒（与设备侧 shell/file/http 超时一致）→ 强制终止并重建 worker |
