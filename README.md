# HyperWidgetMarket · 澎湃组件脚本市场

「[澎湃组件](https://github.com/lswlc33/hyperwidget)」（HyperWidget）的脚本市场：每个脚本是一个**大文件夹**，
CI 扫描生成 [`scripts.json`](./scripts.json) 索引，[展示网页](https://lswlc33.github.io/HyperWidgetMarket/) 与 App 的「市场」页读同一份索引。

- 网页：浏览 / 搜索 / 筛选 / 截图，**不执行任何脚本**
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
tools/build-index.mjs    # 校验 + 生成索引（Node 20，零依赖）
web/ + index.html        # GitHub Pages 展示页
```

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
python -m http.server 8000           # 打开 http://localhost:8000 预览网页
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
