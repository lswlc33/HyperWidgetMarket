#!/usr/bin/env node
/*
 * ============================================================================
 *  studio 完整性检查（CI 的 validate job 会跑，本地也可手动跑）
 * ============================================================================
 *  只做**静态**校验——CI 读不到私有的 App 仓库，所以"快照是否与 App 同步"这里查不了
 *  （那条靠本地 `node tools/sync-studio-assets.mjs --check` 和界面上显示的来源版本号）。
 *  这里守的是"站点/工具能不能正常起来、有没有把本地路径泄进公开仓库"：
 *
 *    1. index.html 引用的本地 js/css/图片资源都存在；
 *    2. 主题快照结构完整（浅/深令牌、≥19 图标、drawable、内置图片、组件库源码）；
 *    3. 快照里的组件库版本与源码里 ui.VERSION 一致；
 *    4. 快照与源码里没有本地绝对路径（盘符 / /Users/ / /home/ 等）；
 *    5. 关键文件在（demo.js、worker.js、engine/render/theme/workspace/editor）。
 *
 *  用法：node tools/check-studio.mjs
 * ============================================================================
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const MARKET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STUDIO = join(MARKET_ROOT, "studio");
const errors = [];
const okList = [];

function ok(msg) { okList.push(msg); }
function bad(msg) { errors.push(msg); }

/* ---------------------------------------------------- 1. 引用的资源都在 */

const html = readFileSync(join(STUDIO, "index.html"), "utf8");
const refs = [];
for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/g)) refs.push(m[1]);
for (const m of html.matchAll(/<link[^>]+href="([^"]+)"/g)) refs.push(m[1]);
const localRefs = refs.filter((r) => !/^(https?:)?\/\//.test(r) && !r.startsWith("data:"));
for (const r of localRefs) {
  const p = join(STUDIO, r);
  if (!existsSync(p)) bad(`index.html 引用了不存在的文件：${r}`);
}
ok(`index.html 的 ${localRefs.length} 个本地引用都存在`);

const REQUIRED = [
  "demo.js", "studio.css",
  "js/engine.js", "js/theme.js", "js/theme.generated.js", "js/render.js",
  "js/workspace.js", "js/editor.js", "js/worker.js", "js/app.js",
  "test-engine.js", "serve.py",
];
for (const f of REQUIRED) {
  if (!existsSync(join(STUDIO, f))) bad(`缺少关键文件：studio/${f}`);
}
ok(`关键文件 ${REQUIRED.length} 个都在`);

/* -------------------------------------------------- 2/3. 主题快照完整性 */

const snapPath = join(STUDIO, "js", "theme.generated.js");
const snapSrc = readFileSync(snapPath, "utf8");
const sandbox = {};
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(snapSrc, sandbox);
const snap = sandbox.HW && sandbox.HW.SNAPSHOT;
if (!snap) {
  bad("theme.generated.js 里没有 HW.SNAPSHOT（生成脚本坏了？）");
} else {
  const light = Object.keys(snap.colors?.light || {});
  const dark = Object.keys(snap.colors?.dark || {});
  if (light.length < 5) bad(`浅色令牌只有 ${light.length} 个（应 ≥5）`);
  if (dark.length < 5) bad(`深色令牌只有 ${dark.length} 个（应 ≥5）`);
  if (light.length >= 5 && dark.length >= 5) ok(`令牌齐全（浅 ${light.length} / 深 ${dark.length}）`);

  const icons = Object.keys(snap.icons || {});
  if (icons.length < 19) bad(`图标只有 ${icons.length} 个（应 ≥19）`);
  else ok(`图标 ${icons.length} 个`);

  for (const name of ["widget_bg", "widget_box_surface", "widget_box_card", "widget_box_accent", "widget_progress", "widget_chip_bg"]) {
    if (!snap.drawables?.[name]) bad(`快照缺 drawable：${name}`);
  }
  ok(`drawable ${Object.keys(snap.drawables || {}).length} 个`);

  const assets = Object.keys(snap.assets || {});
  if (!assets.length) bad("快照里没有内置图片白名单（AssetsImages.NAMES 没被解析到？）");
  for (const a of assets) {
    if (!snap.assetsData?.[a]) bad(`内置图片 ${a} 没有内嵌 base64 数据`);
  }
  if (assets.length) ok(`内置图片：${assets.join("、")}（含 base64）`);

  if (!snap.uiSource || snap.uiSource.length < 4000) {
    bad(`组件库源码异常（${snap.uiSource ? snap.uiSource.length + " 字符" : "缺失"}）`);
  } else {
    ok(`组件库源码 ${snap.uiSource.length} 字符`);
  }

  const declared = /ui\.VERSION\s*=\s*"([^"]*)"/.exec(snap.uiSource || "");
  if (!declared) bad("组件库源码里找不到 ui.VERSION");
  else if (snap.uiVersion !== declared[1]) bad(`快照记录的组件库版本(${snap.uiVersion}) 与源码(${declared[1]}) 不一致`);
  else ok(`组件库版本一致：ui ${snap.uiVersion}`);

  if (!snap.app || (!snap.app.sha && !snap.app.dirty)) bad("快照没有来源版本戳（app.sha）");
  else ok(`来源版本戳：App@${snap.app.sha || "?"}${snap.app.dirty ? "+dirty" : ""} · ${String(snap.generatedAt).slice(0, 16).replace("T", " ")}`);
}

/* -------------------------------------- 4. 不许把本地绝对路径泄进公开仓库 */

const LEAK = [
  /\b[A-Za-z]:[\\/](?:Users|AI_Program|Dev|Projects|code|src)\b/,   // E:\AI_Program\...
  /\/Users\/[A-Za-z0-9._-]+\//,
  /\/home\/[A-Za-z0-9._-]+\//,
  /\bC:\\Users\\/,
];
for (const [file, text] of [["js/theme.generated.js", snapSrc], ["js/app.js", readFileSync(join(STUDIO, "js/app.js"), "utf8")]]) {
  for (const re of LEAK) {
    const m = re.exec(text);
    if (m) bad(`${file} 里疑似本地绝对路径：${m[0]}`);
  }
}
ok("没有本地绝对路径泄漏");

/* ---------------------------------------------------------------- 汇总 */

for (const m of okList) console.log("  ✓ " + m);
if (errors.length) {
  console.error("\n✗ studio 检查未通过：");
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}
console.log("\n✓ studio 检查通过（快照结构、引用完整性、无路径泄漏）");
