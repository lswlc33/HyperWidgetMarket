# HyperWidgetMarket · 澎湃组件脚本市场

「[澎湃组件](https://github.com/lswlc33/hyperwidget)」（HyperWidget）的脚本市场：每个脚本是一个**大文件夹**，
CI 扫描生成 [`scripts.json`](./scripts.json) 索引，[展示网页](https://lswlc33.github.io/HyperWidgetMarket/) 与 App 的「市场」页读同一份索引。

- 网页：浏览 / 搜索 / 筛选 / 截图，**不执行任何脚本**
- 设计工具：[`/studio/`](https://lswlc33.github.io/HyperWidgetMarket/studio/) —— 网页版脚本编辑器，左边写 JS、右边按真实画布实时预览（见下）
- 索引：`scripts.json`（自动生成，勿手改），App 以它为唯一后端
- 安装：应用内「市场」页一键安装；也可手动复制到 `Download/HyperWidget/`

## 目录结构

```
scripts/<id>/            # 一个脚本 = 一个文件夹；id 全小写 kebab-case，发布后不要改名
├─ <id>.js               # 脚本本体（必须与文件夹同名；元数据常量 + function render）
├─ assets/               # 可选：静态资源，安装时整目录复制到设备
├─ preview/              # 可选：截图（<尺寸>.png / <尺寸>-dark.png，尺寸 ∈ 2x2/4x2/4x4）
├─ market.json           # 可选：分类 / 标签 / 许可 / 更新说明
└─ README.md             # 可选：面向使用者的说明
scripts.json             # CI 产物：市场索引（应用后端契约）
studio/                  # 网页版小部件设计工具（GitHub Pages 直接托管）
  ├─ js/                 #   engine（引擎语义移植）/ render（渲染复刻）/ worker（ctx mock）/ app（界面）…
  ├─ js/theme.generated.js  # 主题快照：令牌 + 图标 + 组件库（自动生成，勿手改）
  └─ serve.py            #  本地开发服务器（--app <App 仓库> 可直读 res/ 与组件库）
tools/build-index.mjs    # 校验 + 生成索引（Node 20，零依赖）
tools/sync-studio-assets.mjs  # 从 App 仓库生成 studio 的主题快照
tools/check-studio.mjs   # studio 完整性检查（CI 关卡）
web/ + index.html        # GitHub Pages 展示页
```

## 小部件设计工具（studio）

<https://lswlc33.github.io/HyperWidgetMarket/studio/> —— 纯静态网页，Chrome / Edge 打开即用：

- **左编辑器右实时预览**：Monaco（VS Code 内核）写脚本，右侧按 2×2 / 4×2 / 4×4 的真实画布 dp 渲染；输入停 400ms 自动重跑。
- **直接读写你的脚本目录**：`打开文件夹` 选 `Download/HyperWidget/`，左栏列出脚本与同名资源文件夹（图片可缩略图预览、一键插入 `ui.image`），`Ctrl+S` 写回文件并自动维护 `UPDATED_AT`。
- **语义与 App 一致**：节点白名单/令牌/上限/报错文案是引擎（`LayoutNode`/`RenderSpec`/`ScriptMeta`）的移植，**报错逐字相同**并标行号；还会提醒"内容超出安全区""stack/box 里多个子项会叠""疑似 Rhino 不支持的语法"等真机才会暴露的问题。
- **数据可造**：电量 / 时间 / 设备 / 脚本参数（`ctx.env`）/ 全局变量（`ctx.global`）/ `ctx.http`·`ctx.shell` 的 mock 表。

预览是**浏览器渲染的近似值**（字体排版有残差、宿主主题差异无法复现），版式结论请以真机为准。

### 主题快照（改了 App 资源要重跑）

线上页面读不到私有的 App 仓库，所以令牌、19 个图标、drawable 与组件库 `widget-ui.js` 由
`studio/js/theme.generated.js` 提供。**App 侧改了 `res/values*/widget_colors.xml`、`res/drawable/ic_w_*.xml`
或 `assets/widget-ui.js` 之后**，在本仓库跑一次并提交：

```bash
node tools/sync-studio-assets.mjs --app <App 仓库路径>   # 重新生成快照
node tools/sync-studio-assets.mjs --app <App 仓库路径> --check   # 只比对，不一致退出 1
node tools/check-studio.mjs && node studio/test-engine.js        # 完整性 + 62 项语义自测（CI 同款）
```

本地开发（想改令牌/图标立刻生效，不等快照）：

```bash
python studio/serve.py 8611 --app <App 仓库路径>   # 打开 http://127.0.0.1:8611/studio/
```

工具在界面上会显示当前主题来源（`仓库直读` / `主题快照` / `内置兜底`），只有落到"内置兜底"才说明真的没读到。

## 发布一个脚本

1. Fork 本仓库，新建 `scripts/<你的脚本 id>/`（id 例如 `battery-ring`，ASCII 小写与连字符）。
2. 放进 `<id>.js`，脚本开头声明元数据（**必须是字面量**，App 与 CI 都只做静态扫描）：

   ```js
   const NAME = "电量手环";              // 必填
   const DESCRIPTION = "环形电量与功率";  // 必填
   const VERSION = "1.0.0";             // 必填，semver
   const AUTHOR = "你的名字";            // 必填
   const SIZES = ["2x2", "4x2"];        // 至少一个：2x2 / 4x2 / 4x4
   const MIN_ENGINE = "1.0";            // 可选：要求的最低规范版本

   function render(ctx) { /* … */ }
   ```

   脚本写法见[开发手册](https://github.com/lswlc33/hyperwidget/blob/main/docs/小组件开发手册.md)。
3. 需要图片就放进 `assets/`（脚本里用 `path: "assets/文件名.png"`，支持子目录；单个 ≤1MB、合计 ≤4MB）。
4. 建议放几张截图到 `preview/`：`4x2.png`、`4x2-dark.png`、`2x2.png`…（真机渲染图最佳，单张 ≤1MB）。
5. 可选：写 `market.json`：

   ```json
   { "category": "电量", "tags": ["电量", "充电"], "license": "MIT",
     "changelog": "1.0.0：首个版本", "official": false }
   ```

   分类取：`时钟 / 系统 / 电量 / 网络 / 天气 / 效率 / 示例 / 其他`；标签 ≤5 个。
6. 提 PR。CI 会跑 `node tools/build-index.mjs --check`；通过并合并后，GitHub Actions 自动重建 `scripts.json`，网页与 App 随即可见。

本地自测：

```bash
node tools/build-index.mjs --check   # 只校验
node tools/build-index.mjs           # 校验并生成 scripts.json
node tools/check-studio.mjs          # 设计工具完整性（快照结构 / 引用 / 不泄本地路径）
node studio/test-engine.js           # 设计工具语义层自测（62 项，零依赖）
python studio/serve.py 8000          # 本地预览：http://127.0.0.1:8000/studio/
```

## 校验规则（CI 关卡）

| 项 | 规则 |
|---|---|
| 命名 | 文件夹名 `^[a-z0-9][a-z0-9-]{1,39}$`，JS 必须与文件夹同名 |
| 元数据 | `NAME/DESCRIPTION/VERSION/AUTHOR` 必填且为字面量；`VERSION` 必须 semver；`SIZES` 非空 |
| 渲染入口 | 必须定义 `function render(` |
| 体积 | JS ≤ 64KB；单资源 ≤ 1MB、合计 ≤ 4MB；单截图 ≤ 1MB |
| 格式 | 资源 ∈ png/jpg/jpeg/webp/gif/bmp；截图 ∈ png/jpg/webp |
| 目录 | 脚本文件夹只允许 `<id>.js` / `assets/` / `preview/` / `market.json` / `README.md` |
| 能力扫描 | 命中 `ctx.shell` / `ctx.file` / `ctx.http*` 会记入索引 `uses`（不阻断；命中 shell 时 CI 会提醒人工确认） |

## 索引契约（`scripts.json`）

`schema: 1`。App 以「仓库根 URL 前缀 + 相对路径」取数（默认镜像顺序：自定义源 → jsDelivr → raw.githubusercontent → Pages）。
每个条目包含：`id / name / description / version / author / sizes / minEngine / updatedAt / path / entry /
jsBytes / jsSha256 / assets[] / previews[] / official / category / tags / license / changelog / uses`。
字段含义与 App 侧设计见 [脚本市场建设计划](https://github.com/lswlc33/hyperwidget/blob/main/docs/脚本市场建设计划.md)。

## 安全

脚本经 Rhino 引擎执行，能力与应用内自建脚本相同（可调用 shell / 文件 / 网络）。CI 只做机械校验，
**PR 由维护者人工评审**是最终闸门；请如实填写用途，不要在脚本里收集用户数据或做与描述不符的事情。

## 许可

本仓库的索引、工具与网页代码以 MIT 发布；各脚本的许可见其 `market.json` 的 `license` 字段（默认 MIT）。
