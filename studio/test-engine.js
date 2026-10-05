/*
 * 小部件设计工具 · 语义层自测（Node 里跑，不需要浏览器、也不需要 App 仓库）
 *
 *   node studio/test-engine.js              # 用提交在本仓库的主题快照（CI 也这么跑）
 *   node studio/test-engine.js --app=<App仓库>   # 有 App 仓库时直读它的最新版
 *
 * 覆盖：
 *   1. HW.util.md5 / cacheFileName 与 Node crypto 对拍（缓存文件名必须与设备一致，否则找不到真机缓存）
 *   2. formatTime（Java SimpleDateFormat 子集）
 *   3. ScriptMeta / ScriptPreset 静态扫描 + withUpdatedAt 三种插入路径
 *   4. parseSpec 的每一条报错文案（要与 LayoutNode.java / RenderSpec.java 一字不差）
 *   5. demo.js（+ 组件库）在三档尺寸下都能解析，且节点数不超上限
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const HW = require("./js/engine.js");
require("./js/theme.generated.js");   // 主题快照（可能不存在 → HW.SNAPSHOT 为 undefined）

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "\n      " + extra : "")); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, "实际: " + JSON.stringify(actual) + "\n      期望: " + JSON.stringify(expected));
}
function section(t) { console.log("\n" + t); }

/* ---------------------------------------------------------- 1. MD5 / 缓存名 */
section("1. MD5 / cacheFileName");
const md5cases = ["", "a", "abc", "https://example.com/a.png?v=2",
  "https://api-takumi-record.mihoyo.com/game_record/hkrpg/game/get_widget_avatar_list?role_id=123456&server=cn_gf01",
  "中文路径/图 标.webp"];
md5cases.forEach((s) => {
  const mine = HW.util.md5(HW.util.utf8(s));
  const node = crypto.createHash("md5").update(Buffer.from(s, "utf8")).digest("hex");
  eq("md5(" + JSON.stringify(s.slice(0, 32)) + ")", mine, node);
});
// 与 ScriptStore.cacheFileName 的 Kotlin 实现对照（<hash10>-<末段去查询串，非法字符换 _，最多 40 字符>）
// 注意：Kotlin 用的是 substringAfterLast('/').substringBefore('?')，**不做 URL 解码**，这里照抄
const url1 = "https://example.com/bg/art%20work.png?x=1";
const kt1 = crypto.createHash("md5").update(Buffer.from(url1, "utf8")).digest("hex").slice(0, 10) + "-art%20work.png";
eq("cacheFileName(带查询串/转义)", HW.util.cacheFileName(url1), kt1);
eq("cacheFileName(末尾是 /)",
  HW.util.cacheFileName("https://example.com/"),
  crypto.createHash("md5").update(Buffer.from("https://example.com/", "utf8")).digest("hex").slice(0, 10) + "-cache");
eq("cacheFileName(末段含非法字符)",
  HW.util.cacheFileName("https://example.com/a:b*c.png"),
  crypto.createHash("md5").update(Buffer.from("https://example.com/a:b*c.png", "utf8")).digest("hex").slice(0, 10) + "-a_b_c.png");

/* ---------------------------------------------------------- 2. formatTime */
section("2. formatTime（ctx.time / clock 节点）");
const d = new Date(2026, 9, 5, 15, 7, 9, 42);   // 2026-10-05 15:07:09
eq("HH:mm", HW.util.formatTime("HH:mm", d), "15:07");
eq("HH:mm:ss", HW.util.formatTime("HH:mm:ss", d), "15:07:09");
eq("yyyy-MM-dd HH:mm", HW.util.formatTime("yyyy-MM-dd HH:mm", d), "2026-10-05 15:07");
eq("默认值(空串)", HW.util.formatTime("", d), "15:07");
eq("E", HW.util.formatTime("E", d), "周一");
eq("未知字母原样", HW.util.formatTime("qq:mm", d), "qq:07");
eq("引号字面量", HW.util.formatTime("'第'H时", d), "第15时");

/* ------------------------------------------------- 3. 元数据 / 参数 / UPDATED_AT */
section("3. ScriptMeta / ScriptPreset 扫描");
const src = [
  "const NAME = \"测试脚本\";",
  "const DESCRIPTION = \"描述\";",
  "const VERSION = \"1.2.3\";",
  "const AUTHOR = \"lswlc\";",
  "const SIZES = [\"4x2\", \"9x9\", \"2x2\"];",
  "const MIN_ENGINE = \"1.0\";",
  "const PRESETS = {",
  "  city: { title: \"城市\", default: \"北京\" },",
  "  showSec: { title: \"显示秒\", type: \"switch\", default: false },",
  "};",
  "const GLOBALS = { unit: { title: \"单位\", default: \"C\" } };",
  "",
  "function render(ctx) {",
  "  const NAME = \"render 里的同名变量不该被扫到\";",
  "  return { title: NAME };",
  "}",
].join("\n");
const m = HW.scanMeta(src);
eq("NAME", m.name, "测试脚本");
eq("SIZES 过滤非法值", JSON.stringify(m.sizes), JSON.stringify(["4x2", "2x2"]));
eq("UPDATED_AT 未声明", m.updatedAt, null);
eq("missingRequired", JSON.stringify(m.missingRequired), JSON.stringify([]));
eq("versionValid", m.versionValid, true);
eq("minEngineSatisfied", m.minEngineSatisfied, true);
ok("render 体内的同名变量不污染", m.name === "测试脚本");
eq("MIN_ENGINE 2.0 不满足", HW.scanMeta("const MIN_ENGINE = \"2.0\";").minEngineSatisfied, false);
eq("VERSION 非法", HW.scanMeta("const VERSION = \"1.2\";").versionValid, false);

const presets = HW.scanDeclarations(src, "PRESETS");
eq("PRESETS 条数", presets.items.length, 2);
eq("PRESETS 顺序/标题", presets.items[0].key + ":" + presets.items[0].title, "city:城市");
eq("switch 默认值", presets.items[1].isSwitch + "/" + presets.items[1].default, "true/false");

const loose = HW.scanDeclarations("const PRESETS = { a: { title: '单引号', }, };\nfunction render(){}", "PRESETS");
eq("非严格 JSON 仍能渲染但标 strictJson=false", loose.strictJson + "/" + loose.items.length, "false/1");

const w1 = HW.withUpdatedAt("const AUTHOR = \"x\"\nfunction render(){}", d);
ok("UPDATED_AT 插到 AUTHOR 之后（无分号也不粘连）",
  w1.indexOf('const AUTHOR = "x"\nconst UPDATED_AT = "2026-10-05 15:07"\nfunction render') >= 0, w1);
const w1b = HW.withUpdatedAt("const AUTHOR = \"x\";\nconst SIZES = [];\n", d);
ok("UPDATED_AT 插到 AUTHOR 之后（有分号）",
  w1b.indexOf('const AUTHOR = "x";\nconst UPDATED_AT = "2026-10-05 15:07"\nconst SIZES') >= 0, w1b);
ok("插入后仍是合法 JS", (function () {
  try { new Function(w1); new Function(w1b); return true; } catch (e) { return false; }
})(), w1);
const w2 = HW.withUpdatedAt("const AUTHOR = \"x\";\nconst UPDATED_AT = \"2000-01-01 00:00\";\n", d);
ok("已有时原地替换", w2.indexOf("2026-10-05 15:07") > 0 && w2.indexOf("2000-01-01") < 0, w2);
const w3 = HW.withUpdatedAt("function render(){}", d);
ok("都没有时插到文件头", w3.startsWith("// 元数据规范建议"), w3);

/* ---------------------------------------------------------- 4. parseSpec 报错 */
section("4. parseSpec 校验（文案必须与 Java 一致）");
function specOf(layout) { return HW.parseSpec({ layout: layout }); }
function errOf(fn) {
  try { fn(); return null; } catch (e) { return e.message; }
}
eq("经典字段 + refresh 钳到 15", HW.parseSpec({ title: "t", refresh: 5 }).refreshSec, 15);
eq("rows 上限 4", HW.parseSpec({ rows: [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10]] }).rows.length, 4);
eq("tap 空串回落 refresh", HW.parseSpec({ tap: "   " }).tap, "refresh");
eq("未知 type", errOf(() => specOf({ type: "fancy" })),
  "未知的布局节点 type: fancy（可用: " + HW.NODE_TYPES.join(", ") + "）");
eq("嵌套深度", errOf(() => {
  let n = { type: "text" };
  for (let i = 0; i < 7; i++) n = { type: "column", children: [n] };
  specOf(n);
}), "布局嵌套深度超过上限 6 层，请拆分或扁平化");
eq("节点数上限", errOf(() => specOf({
  type: "column", children: Array.from({ length: 80 }, () => ({ type: "text" })),
})), "布局节点数超过上限 80（当前 81），请精简节点树");
eq("属性不支持嵌套对象", errOf(() => specOf({ type: "text", style: { a: 1 } })),
  "布局属性 style 不支持嵌套对象");
eq("text 非法令牌", errOf(() => specOf({ type: "text", color: "#ff0000" })),
  "text 节点的 color 只能用令牌 [primary, secondary, accent]，收到: \"#ff0000\"（禁止写死颜色，深色模式走 values-night）");
eq("box 非法令牌", errOf(() => specOf({ type: "box", bg: "red" })),
  "box 节点的 bg 只能用令牌 [surface, card, accent, none]，收到: \"red\"（禁止写死颜色，深色模式走 values-night）");
ok("box 合法令牌通过", !!specOf({ type: "box", bg: "none" }));
eq("box 上的 gravity", errOf(() => specOf({ type: "box", gravity: "center" })),
  "box 节点不支持 gravity：只有 LinearLayout 有 setGravity，GridLayout/FrameLayout 上调用会在 RemoteViews 应用时抛 ActionException。" +
  "需要居中请把子节点包一层 { type: \"column\", w: \"match\", h: \"match\", gravity: \"center\" }");
eq("grow 拦截", errOf(() => specOf({ type: "row", children: [{ type: "text", grow: 1 }] })),
  "text 节点不支持 grow/weight：RemoteViews 无法设置 LinearLayout 权重。需要占满行内剩余宽度请用 w: \"match\"" +
  "（只对行内最后一个节点有效，前面的节点会先按内容宽度占位）");
eq("row 中间 match", errOf(() => specOf({
  type: "row", children: [{ type: "text", w: "match" }, { type: "text" }],
})), "row 的第 1 个节点写了 w: \"match\"，但它不是最后一个：match 会吃掉整行剩余宽度，把后面的节点挤出去。" +
  "想让「标签在左、值在右」，请把 w: \"match\" 写在行尾的那个节点上（配 align: \"end\"）");
ok("row 行尾 match 通过", !!specOf({ type: "row", children: [{ type: "text" }, { type: "text", w: "match" }] }));
eq("children 非节点", errOf(() => specOf({ type: "column", children: ["x"] })),
  "children 里必须是节点对象，第 1 项不是");
eq("render() 必须返回对象", errOf(() => HW.parseSpec(null)), "render() 必须返回对象");
const tree = specOf({ type: "column", gap: 6, children: [{ type: "text", text: "hi", size: 14 }] });
eq("mode", tree.mode, "tree");
eq("nodeCount", tree.nodeCount, 2);
eq("props 纯数据可序列化", JSON.stringify(tree).indexOf("children") > 0, true);

/* ---------------------------------------- 5. demo.js × 真组件库 × 三档尺寸 */
section("5. demo.js（+ 组件库）三档解析");
/** 组件库源码：快照优先（CI/线上靠它），给了 App 仓库则直读最新版。 */
function loadUiSource() {
  const argApp = (process.argv.find((a) => a.startsWith("--app=")) || "").slice(6);
  const appDir = argApp || process.env.HAPP_REPO || "";
  const candidates = [
    appDir && path.join(appDir, "app/src/main/assets/widget-ui.js"),
    path.resolve(__dirname, "../../pa-widget-hook/app/src/main/assets/widget-ui.js"),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return { src: fs.readFileSync(p, "utf8"), from: "App 仓库直读 " + p };
  }
  if (HW.SNAPSHOT && HW.SNAPSHOT.uiSource) {
    return {
      src: HW.SNAPSHOT.uiSource,
      from: "主题快照（App@" + ((HW.SNAPSHOT.app && HW.SNAPSHOT.app.sha) || "?") +
        " · 生成于 " + String(HW.SNAPSHOT.generatedAt || "").slice(0, 10) + "）",
    };
  }
  throw new Error("拿不到 widget-ui.js：跑一次 node tools/sync-studio-assets.mjs，或用 --app=<App 仓库>");
}
const uiLoad = loadUiSource();
console.log("  组件库来源：" + uiLoad.from);
const uiSrc = uiLoad.src;
const ui = new Function(uiSrc + "\n;return ui;")();
const demoSrc = fs.readFileSync(path.join(__dirname, "demo.js"), "utf8");
const meta = HW.scanMeta(demoSrc);
eq("demo 元数据", meta.name + "/" + meta.version + "/" + meta.sizes.join(","), "设计工具演示/1.0.0/2x2,4x2,4x4");
eq("demo PRESETS", HW.scanDeclarations(demoSrc, "PRESETS").items.length, 2);
ok("demo 没有 Rhino 风险写法", HW.scanRhinoRisks(demoSrc).filter((r) => r.level === "error").length === 0,
  JSON.stringify(HW.scanRhinoRisks(demoSrc)));

function fakeCtx(w, h) {
  return {
    size: () => ({ w: w, h: h }),
    sizeClass: () => HW.sizeClassOf(w, h),
    battery: () => ({ level: 76, charging: true, plugged: true, currentMa: -420, voltageV: 4.12, tempC: 30.5, powerW: -1.73 }),
    time: (p) => HW.util.formatTime(p, d),
    uptime: () => 12.5,
    env: (k, f) => (k === "greeting" ? "下午好" : k === "showBars" ? "true" : (f === undefined ? null : f)),
    global: (k, f) => (k === "city" ? "北京" : (f === undefined ? null : f)),
    device: () => ({ model: "网页预览", androidVersion: "15", isDarkMode: false }),
    log: () => { },
  };
}
const run = new Function("ctx", "ui", demoSrc + "\n;return render(ctx);");
[["2x2", 163, 163], ["4x2", 350, 166], ["4x4", 350, 365]].forEach(([cls, w, h]) => {
  const ret = run(fakeCtx(w, h), ui);
  const spec = HW.parseSpec(ret);
  const n = spec.nodeCount || 0;
  ok(cls + " 解析通过（" + n + " 节点, refresh=" + spec.refreshSec + "s, tap=" + spec.tap + "）",
    spec.mode === "tree" && n > 0 && n <= HW.MAX_NODES, JSON.stringify(spec).slice(0, 200));
  // 递归统计一遍，防止 nodeCount 与实际不符
  let counted = 0;
  (function walk(x) { counted++; (x.children || []).forEach(walk); })(spec.root);
  eq(cls + " 节点计数一致", counted, n);
});

/* ---------------------------------------------------------------- 汇总 */
console.log("\n" + (fail ? "✗" : "✓") + " 通过 " + pass + " 项，失败 " + fail + " 项");
process.exit(fail ? 1 : 0);
