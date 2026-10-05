#!/usr/bin/env node
/*
 * ============================================================================
 *  studio 主题快照生成器（App 仓库 → 市场仓库 studio/js/theme.generated.js）
 * ============================================================================
 *  为什么需要它：网页设计工具（studio/）原本**运行时直读** App 仓库的
 *    app/src/main/res/values 与 values-night 的 widget_colors.xml  → 颜色令牌
 *    app/src/main/res/drawable/ic_w_*.xml         → 19 个内置图标
 *    app/src/main/res/drawable/widget_*.xml       → 背景/面板/进度条形状
 *    app/src/main/assets/widget-ui.js             → 组件库 ui.*（脚本作用域要注入它）
 *    app/src/main/assets/widget_*.*               → image 节点 res 白名单（含位图）
 *  但 App 仓库不公开，GitHub Pages 上的在线版读不到它们——所以把这份真值**打成快照**提交进市场仓库：
 *    · 在线（Pages）→ 用快照，能力与本地完全一致；
 *    · 本地（serve.py --app <App 仓库>）→ 仍然直读，改 res/ 立刻生效。
 *
 *  用法：
 *    node tools/sync-studio-assets.mjs                 # 默认读 ../pa-widget-hook
 *    node tools/sync-studio-assets.mjs --app D:/x/app  # 指定 App 仓库
 *    node tools/sync-studio-assets.mjs --check         # 只比对，不一致就退出 1（提交前的自检）
 *
 *  ⚠️ 改了 App 的 res/ 或 widget-ui.js 之后要重跑本脚本并提交 studio/js/theme.generated.js，
 *     否则在线版会停留在旧主题（studio 界面上会显示快照的来源版本，便于核对）。
 * ============================================================================
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, basename, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const MARKET_ROOT = resolve(HERE, "..");
const OUT_FILE = join(MARKET_ROOT, "studio", "js", "theme.generated.js");

/* --------------------------------------------------------------- 参数 */

const argv = process.argv.slice(2);
function argValue(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}
const CHECK_ONLY = argv.includes("--check");
/** 降级模式：快照不含组件库源码（在线版脚本里 ui.* 会不可用，只保令牌与图标）。 */
const NO_UI_SOURCE = argv.includes("--no-ui-source");
const APP_DIR = resolve(argValue("--app") || process.env.HAPP_REPO || join(MARKET_ROOT, "..", "pa-widget-hook"));

const RES = join(APP_DIR, "app", "src", "main", "res");
const ASSETS = join(APP_DIR, "app", "src", "main", "assets");

function fail(msg) {
  console.error("✗ " + msg);
  process.exit(1);
}
if (!existsSync(RES)) {
  fail(`找不到 App 仓库资源目录：${RES}\n  用 --app <App 仓库路径> 指定，或把两个仓库放在同级目录下`);
}

/* --------------------------------------------------------------- 解析 */

const sha8 = (text) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 8);
const files = {};   // 相对 App 仓库的路径 → sha256 前 8 位（人肉核对用）

function readRes(rel) {
  const p = join(APP_DIR, rel);
  if (!existsSync(p)) fail("缺少文件：" + rel);
  const text = readFileSync(p, "utf8");
  files[rel.replace(/\\/g, "/")] = sha8(text);
  return text;
}

/** <color name="x">#AARRGGBB</color> → { x: "#AARRGGBB" } */
function parseColors(xml) {
  const out = {};
  const re = /<color\s+name="([^"]+)"\s*>([^<]+)<\/color>/g;
  let m;
  while ((m = re.exec(xml))) out[m[1]] = m[2].trim();
  return out;
}

/** shape / layer-list → { radius, color } | { layer:true, background:{}, progress:{} } */
function parseShape(block) {
  const out = {};
  const corners = /<corners[^>]*android:radius="([\d.]+)dp"/.exec(block);
  if (corners) out.radius = Number(corners[1]) || 0;
  const solid = /<solid[^>]*android:color="([^"]+)"/.exec(block);
  if (solid) out.color = solid[1];
  return out;
}
function parseDrawable(xml) {
  if (/<layer-list/.test(xml)) {
    const out = { layer: true };
    const items = xml.split(/<item\b/).slice(1);
    for (const it of items) {
      const shape = /<shape[\s\S]*?<\/shape>/.exec(it);
      if (!shape) continue;
      const parsed = parseShape(shape[0]);
      if (/android:id="@android:id\/background"/.test(it)) out.background = parsed;
      else if (/android:id="@android:id\/progress"/.test(it)) out.progress = parsed;
      else out.item = parsed;
    }
    return out;
  }
  return parseShape(xml);
}

/** vector → { viewBox, paths:[pathData] } */
function parseVector(xml) {
  const vw = /android:viewportWidth="([\d.]+)"/.exec(xml);
  const vh = /android:viewportHeight="([\d.]+)"/.exec(xml);
  const paths = [];
  const re = /<path[^>]*android:pathData="([^"]+)"/g;
  let m;
  while ((m = re.exec(xml))) paths.push(m[1].trim().replace(/\s+/g, " "));
  return { viewBox: `0 0 ${vw ? vw[1] : 24} ${vh ? vh[1] : 24}`, paths };
}

const IMAGE_MIME = {
  webp: "image/webp", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", svg: "image/svg+xml", bmp: "image/bmp", avif: "image/avif",
};

/* --------------------------------------------------------------- 采集 */

const colors = {
  light: parseColors(readRes("app/src/main/res/values/widget_colors.xml")),
  dark: parseColors(readRes("app/src/main/res/values-night/widget_colors.xml")),
};

const DRAWABLE_NAMES = [
  "widget_bg", "widget_box_surface", "widget_box_card",
  "widget_box_accent", "widget_progress", "widget_chip_bg",
];
const drawables = {};
for (const n of DRAWABLE_NAMES) {
  drawables[n] = parseDrawable(readRes(`app/src/main/res/drawable/${n}.xml`));
}

// 图标：直接扫目录（新增图标不用改这个脚本）
const drawableDir = join(RES, "drawable");
const iconNames = readdirSync(drawableDir)
  .filter((f) => /^ic_w_[a-z0-9_]+\.xml$/.test(f))
  .map((f) => f.replace(/^ic_w_/, "").replace(/\.xml$/, ""))
  .sort();
if (iconNames.length < 19) fail(`图标数量异常：只找到 ${iconNames.length} 个 ic_w_*.xml`);
const icons = {};
for (const n of iconNames) icons[n] = parseVector(readRes(`app/src/main/res/drawable/ic_w_${n}.xml`));

// 组件库源码（脚本作用域要注入）；--no-ui-source 时留空 = 降级模式（在线版 ui.* 不可用）
const uiSourceFull = readRes("app/src/main/assets/widget-ui.js");
const uiVersion = (() => {
  const m = /ui\.VERSION\s*=\s*"([^"]*)"/.exec(uiSourceFull);
  return m ? m[1] : null;
})();
const uiSource = NO_UI_SOURCE ? "" : uiSourceFull;

// 内置图片白名单：AssetsImages.NAMES（Kotlin 里的 "名字" to "文件名"）+ 位图本体（base64，离线也要能用）
const assetsKt = readRes("app/src/main/java/io/github/lswlc33/hyperwidget/widget/AssetsImages.kt");
const assets = {};
{
  const re = /"([A-Za-z0-9_]+)"\s+to\s+"([^"]+)"/g;
  let m;
  while ((m = re.exec(assetsKt))) assets[m[1]] = m[2];
}
const assetsData = {};
for (const [resName, fileName] of Object.entries(assets)) {
  const p = join(ASSETS, fileName);
  if (!existsSync(p)) fail(`内置资源缺少文件：${fileName}`);
  const buf = readFileSync(p);
  const ext = fileName.split(".").pop().toLowerCase();
  const mime = IMAGE_MIME[ext] || "application/octet-stream";
  assetsData[resName] = `data:${mime};base64,${buf.toString("base64")}`;
  files[`app/src/main/assets/${fileName}`] = sha8(buf.toString("base64"));
}

// App 仓库版本（便于核对快照新旧）
let appGit = { sha: null, dirty: false };
try {
  appGit.sha = execFileSync("git", ["-C", APP_DIR, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  appGit.dirty = execFileSync("git", ["-C", APP_DIR, "status", "--porcelain"], { encoding: "utf8" }).trim().length > 0;
} catch {
  /* 不是 git 工作区也无所谓，只是少一个核对信息 */
}

const snapshot = {
  generatedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  generator: "HyperWidgetMarket/tools/sync-studio-assets.mjs",
  app: { name: basename(APP_DIR), sha: appGit.sha, dirty: appGit.dirty },
  uiVersion,
  /** 降级模式（--no-ui-source）：线上版不注入组件库，脚本里的 ui.* 会报未定义。 */
  noUiSource: NO_UI_SOURCE || undefined,
  files,
  colors,
  drawables,
  icons,
  assets,
  assetsData,
  uiSource,
};

/* --------------------------------------------------------------- 写出 */

const body = `/*
 * ============================================================================
 *  studio 主题快照 —— 自动生成，请勿手改
 * ============================================================================
 *  生成命令：node tools/sync-studio-assets.mjs --app <App 仓库路径>
 *  来源版本：${snapshot.app.name}@${snapshot.app.sha || "?"}${snapshot.app.dirty ? " (dirty)" : ""}
 *  生成时间：${snapshot.generatedAt}
 *  组件库版本：ui.VERSION = ${uiVersion}${NO_UI_SOURCE ? "（降级模式 --no-ui-source：未内置组件库源码，在线版 ui.* 不可用）" : ""}
 *  内容：颜色令牌（浅/深）· ${iconNames.length} 个图标 pathData · ${DRAWABLE_NAMES.length} 个 drawable 形状 ·
 *        内置图片（res 白名单，base64）· widget-ui.js 全文
 *  作用：在线版（GitHub Pages）读不到 App 仓库，用它保证"令牌/图标/组件库"与 App 一致。
 *        本地用 \`serve.py --app <App 仓库>\` 打开时仍然直读 res/，这份快照只是兜底。
 * ============================================================================
 */
(function (root) {
  "use strict";
  root.HW = root.HW || {};
  root.HW.SNAPSHOT = ${JSON.stringify(snapshot, null, 2)};
})(typeof self !== "undefined" ? self : globalThis);
`;

if (CHECK_ONLY) {
  /** 取快照 JSON 本体（跳过会变动的生成头注释），并把时间/版本戳规范化后比对。 */
  function payloadOf(text) {
    if (!text) return null;
    const marker = "root.HW.SNAPSHOT = ";
    const start = text.indexOf(marker);
    if (start < 0) return null;
    let bodyText = text.slice(start + marker.length);
    const end = bodyText.lastIndexOf("\n})(");
    if (end > 0) bodyText = bodyText.slice(0, end);
    bodyText = bodyText.trim().replace(/;$/, "");
    try {
      const obj = JSON.parse(bodyText);
      if (obj.generatedAt) obj.generatedAt = "X";
      if (obj.app && obj.app.sha) obj.app.sha = "X";
      return JSON.stringify(obj);
    } catch {
      return null;
    }
  }
  const current = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, "utf8") : "";
  const a = payloadOf(current);
  const b = payloadOf(body);
  if (!a || !b || a !== b) {
    console.error("✗ studio/js/theme.generated.js 与 App 仓库当前状态不一致——请重跑不带 --check 的本脚本并提交");
    if (a && b) {
      // 指出第一处差异，省得人肉 diff 一个 52KB 的单行 JSON
      const n = Math.min(a.length, b.length);
      let i = 0;
      while (i < n && a[i] === b[i]) i++;
      console.error("  首个差异在第 " + i + " 字符附近：\n    现存: " + a.slice(Math.max(0, i - 60), i + 60) +
        "\n    应改: " + b.slice(Math.max(0, i - 60), i + 60));
    }
    process.exit(1);
  }
  console.log("✓ 快照与 App 仓库一致（" + iconNames.length + " 图标，ui " + uiVersion + "，源 " +
    (appGit.sha || "?") + "）");
  process.exit(0);
}

writeFileSync(OUT_FILE, body, "utf8");
const kb = (n) => Math.round(n / 1024) + "KB";
console.log("✓ 已写出 studio/js/theme.generated.js（" + kb(Buffer.byteLength(body)) + "）");
console.log("  App 仓库    : " + snapshot.app.name + "@" + (snapshot.app.sha || "?") + (snapshot.app.dirty ? "（工作区有未提交改动）" : ""));
console.log("  组件库      : ui.VERSION = " + uiVersion);
console.log("  图标        : " + iconNames.length + " 个（" + iconNames.join(" ") + "）");
console.log("  令牌        : 浅 " + Object.keys(colors.light).length + " 项 / 深 " + Object.keys(colors.dark).length + " 项");
console.log("  内置图片    : " + Object.keys(assetsData).map((k) => k + "→" + assets[k]).join(", "));
