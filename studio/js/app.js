/*
 * ============================================================================
 *  小部件设计工具 · 主控（工具栏 / 面板 / 联动）
 * ============================================================================
 *  数据流：编辑器改动 → 防抖 400ms → worker 跑脚本 → spec → DOM 渲染 → 面板刷新。
 *  worker 8 秒不返回就 terminate 重建（脚本里写了死循环也冻不住页面）。
 * ============================================================================
 */
(function () {
  "use strict";
  var HW = window.HW;
  var $ = function (id) { return document.getElementById(id); };

  var SETTINGS_KEY = "hw-studio/settings/v1";
  var DEMO_NAME = "demo.js";

  /* --------------------------------------------------------------- 设置 */

  function defaultSettings() {
    return {
      theme: "light",
      density: 3,
      sizeClass: "4x2",
      canvas: JSON.parse(JSON.stringify(HW.DEFAULT_CANVAS)),
      auto: true,
      wrap: true,
      allowNetwork: true,
      httpProxy: "",
      repoBase: "",
      data: {
        battery: { level: 76, charging: false, plugged: false, currentMa: -420, voltageV: 4.12, tempC: 30.5 },
        device: { model: "网页预览", androidVersion: "15" },
      },
      mocks: {},
      mocksText: "{\n  \"shell:cat /sys/class/power_supply/battery/current_now\": \"-420000\",\n  \"http:https://example.com/api\": \"{\\\"ok\\\":true}\"\n}",
      env: {},           // { 脚本名: { key: value } }
      global: {},        // { key: value }
      userGlobals: [],   // 自建全局键
      lastScript: {},    // { 文件夹名: 脚本名 }
    };
  }
  function loadSettings() {
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return defaultSettings();
      var s = JSON.parse(raw);
      var d = defaultSettings();
      Object.keys(d).forEach(function (k) { if (s[k] === undefined) s[k] = d[k]; });
      Object.keys(d.canvas).forEach(function (k) { if (!s.canvas[k]) s.canvas[k] = d.canvas[k]; });
      return s;
    } catch (e) {
      return defaultSettings();
    }
  }
  var settings = loadSettings();
  function persist() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { }
  }

  /* --------------------------------------------------------------- 状态 */

  var S = {
    ws: null,
    sources: {},        // 脚本名 → 源码（用于扫 GLOBALS）
    current: DEMO_NAME,
    code: "",
    dirty: false,
    res: { files: {}, skipped: [], dirName: "", missing: true },
    resUrls: {},
    store: {},
    worker: null,
    runSeq: 0,
    watchdog: null,
    timer: null,
    editor: null,
    disposing: null,
    notes: [],
    logs: [],
    warnings: [],
    lastResult: null,
    readonlyDemo: true,
  };

  /* --------------------------------------------------------------- 小工具 */

  function toast(msg, ms) {
    var t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(t._t);
    t._t = setTimeout(function () { t.hidden = true; }, ms || 2600);
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function canvas() {
    var c = settings.canvas[settings.sizeClass] || HW.DEFAULT_CANVAS["4x2"];
    return { w: c.w, h: c.h };
  }
  function banner(msg, kind) {
    var b = $("banner");
    if (!msg) { b.hidden = true; return; }
    b.hidden = false;
    b.className = "banner " + (kind || "warn");
    b.innerHTML = msg;
  }
  function meta() { return HW.scanMeta(S.code); }

  /* --------------------------------------------------------------- 启动 */

  (async function init() {
    if (typeof Worker === "undefined" || location.protocol === "file:") {
      showOverlay("需要本地服务器", "浏览器的 file:// 页面无法创建 worker、也读不到主题资源。<br>" +
        "在线版直接打开 <code>https://lswlc33.github.io/HyperWidgetMarket/studio/</code> 即可；" +
        "本地开发在 <code>studio/</code> 目录运行 <code>serve.cmd</code>" +
        "（或 <code>python serve.py 8611 --app &lt;App 仓库路径&gt;</code>）后打开 " +
        "<code>http://127.0.0.1:8611/studio/</code>。");
      return;
    }
    // 自检：任何一个 js 文件没起来（语法错/404）都不该白屏，先把原因说出来
    var loadErrors = (window.__hwErrors || []).slice();
    var need = {
      "engine.js": typeof HW.parseSpec === "function" && typeof HW.scanMeta === "function",
      "theme.js": !!HW.theme,
      "render.js": !!HW.renderer,
      "workspace.js": !!HW.workspace,
      "editor.js": !!HW.editor,
    };
    var missing = Object.keys(need).filter(function (k) { return !need[k]; });
    if (missing.length || loadErrors.length) {
      showOverlay("工具没能启动", "缺少模块：<code>" + (missing.join(", ") || "无") + "</code><br>" +
        (loadErrors.length ? "脚本错误：<br><code>" + esc(loadErrors.join("<br>")) + "</code>" : "") +
        "<br>常见原因：用 file:// 打开（必须走本地服务器），或某个 js 文件被改坏了。");
      return;
    }
    // 主题三态：直读 App 仓库（开发）/ 主题快照（线上）/ 内置兜底（异常，飘红）
    await HW.theme.load(settings.repoBase || "");
    applyTheme();   // 必须在 load 之后：令牌是 load 才填进来的
    if (HW.theme.source === "fallback") {
      banner("⚠️ 主题落到内置兜底：没读到 App 仓库，也没有主题快照（<span class='mono'>js/theme.generated.js</span>）。" +
        (HW.theme.problems.length ? "首个失败：<span class='mono'>" + esc(HW.theme.problems[0]) + "</span>" : "") +
        " 图标与 <span class='mono'>ui.*</span> 组件库会不可用。", "warn");
    }
    $("chk-wrap").checked = settings.wrap;
    $("chk-auto").checked = settings.auto;
    buildSizeSeg();
    buildVarsPane();
    buildDataPane();
    wireToolbar();
    wireTabs();
    wireLightbox();

    await loadDemo();
    // 先出预览，再装编辑器：Monaco 要下几 MB（还可能一个源都不可达），
    // 绝不能让它拖住首屏——右侧先渲染 demo，编辑器就位后再把内容灌进去。
    setEditorTitle();
    currentMetaLine();
    buildSizeSeg();
    buildScriptList();
    renderResources();
    run();
    $("ed-title").textContent = "编辑器加载中…（预览不受影响）";
    S.editor = await HW.editor.create($("editor"), onCodeChange, { theme: settings.theme, wrap: settings.wrap });
    if (S.editor.note) banner(esc(S.editor.note), "warn");
    setCode(S.code);
    setEditorTitle();
  })();

  function showOverlay(title, html) {
    $("ov-title").textContent = title;
    $("ov-text").innerHTML = html;
    $("overlay").hidden = false;
    $("ov-retry").onclick = function () { location.reload(); };
  }

  function applyTheme() {
    HW.theme.apply(settings.theme);
    $("btn-theme").textContent = settings.theme === "dark" ? "☀" : "☾";
  }

  /* --------------------------------------------------------- 脚本装载 */

  async function loadDemo() {
    try {
      var res = await fetch("demo.js", { cache: "no-cache" });
      S.code = res.ok ? await res.text() : "function render(ctx) { return { title: \"demo.js 读取失败\" }; }";
    } catch (e) {
      S.code = "function render(ctx) { return { title: \"demo.js 读取失败\" }; }";
    }
    S.current = DEMO_NAME;
    S.readonlyDemo = true;
    S.sources[DEMO_NAME] = S.code;
  }

  function setEditorTitle() {
    $("ed-title").textContent = S.current + (S.ws ? "" : "（示例脚本，打开文件夹后可编辑你自己的脚本）");
    $("dirty-dot").hidden = !S.dirty;
    var canSave = !!S.ws && S.ws.writable && !S.readonlyDemo;
    $("btn-save").disabled = !canSave;
    $("btn-save").title = canSave ? "Ctrl+S" : (S.ws && !S.ws.writable ? "当前浏览器只能预览（Firefox/Safari 无法写回文件）" : "打开文件夹后可保存");
    $("script-select").title = S.current;
  }

  function currentMetaLine() {
    var m = meta();
    var parts = [];
    if (m.name) parts.push(m.name);
    if (m.version) parts.push("v" + m.version);
    if (m.sizes.length) parts.push(m.sizes.join("/"));
    if (m.missingRequired.length && m.declared) parts.push("缺 " + m.missingRequired.join("、"));
    if (!m.declared) parts.push("未声明元数据");
    $("meta-line").textContent = parts.join(" · ");
  }

  async function loadScript(name) {
    var text;
    if (name === DEMO_NAME && !S.ws) text = S.sources[DEMO_NAME];
    else if (S.sources[name] !== undefined && S.current !== name) text = S.sources[name];
    else text = await S.ws.readScript(name);
    S.sources[name] = text;
    S.current = name;
    S.readonlyDemo = false;
    S.store = loadStore(name);
    setCode(text);
    currentMetaLine();
    await scanResources();
    buildVarsPane();
    buildScriptList();
    run();
  }

  /** 主动写入编辑器内容（加载/保存后回写），不触发"已修改"标记。 */
  function setCode(text) {
    S.code = text;
    S.loadingCode = true;
    if (S.editor) S.editor.setValue(text);
    S.loadingCode = false;
    S.dirty = false;
    setEditorTitle();
    currentMetaLine();
    buildSizeSeg();
  }

  /* --------------------------------------------------------- 打开文件夹 */

  async function openFolder() {
    try {
      if (!HW.workspace.supported) {
        $("file-fallback").click();
        return;
      }
      S.ws = await HW.workspace.open();
      await afterWorkspace();
    } catch (e) {
      if (e && e.name === "AbortError") return;
      banner("打开文件夹失败：" + esc(e.message || e) + "（可改用只读方式：Ctrl+点击「打开文件夹」）", "warn");
    }
  }

  async function afterWorkspace() {
    $("ws-name").textContent = S.ws.name + (S.ws.writable ? "" : "（只读）");
    $("btn-new").hidden = !S.ws.writable;
    var list = await S.ws.listScripts();
    S.sources = {};
    for (var i = 0; i < list.length; i++) {
      try { S.sources[list[i]] = await S.ws.readScript(list[i]); } catch (e) { S.sources[list[i]] = ""; }
    }
    S.scripts = list;
    if (!list.length) {
      banner("这个文件夹里还没有 .js 脚本。用「新建脚本」开一个，或确认选的是 Download/HyperWidget 目录。", "warn");
      buildScriptList();
      return;
    }
    banner("");
    var last = settings.lastScript[S.ws.name];
    var pick = list.indexOf(last) >= 0 ? last : list[0];
    await loadScript(pick);
  }

  function buildScriptList() {
    var ul = $("script-list");
    ul.innerHTML = "";
    var names = S.ws ? (S.scripts || []) : [DEMO_NAME];
    if (!names.length) names = [DEMO_NAME];
    names.forEach(function (n) {
      var li = el("li", "script-item" + (n === S.current ? " active" : ""));
      var m = HW.scanMeta(S.sources[n] !== undefined ? S.sources[n] : "");
      var title = el("div", "script-name", m.name && m.name.trim() ? m.name : n.replace(/\.js$/i, ""));
      var sub = el("div", "script-sub mono", n + (m.version ? " · v" + m.version : "") + (m.sizes.length ? " · " + m.sizes.join("/") : ""));
      li.appendChild(title);
      li.appendChild(sub);
      li.onclick = function () { switchTo(n); };
      ul.appendChild(li);
    });

    var sel = $("script-select");
    sel.innerHTML = "";
    names.forEach(function (n) {
      var o = document.createElement("option");
      o.value = n;
      o.textContent = n;
      if (n === S.current) o.selected = true;
      sel.appendChild(o);
    });
  }

  async function switchTo(name) {
    if (name === S.current) return;
    if (S.dirty && !confirm("「" + S.current + "」有未保存的修改，继续切换会丢失。要先保存吗？\n\n确定 = 保存并切换，取消 = 直接切换")) {
      // 取消 = 直接切换（不保存）
    } else if (S.dirty) {
      await saveCurrent();
    }
    if (!S.ws) return;
    await loadScript(name);
    if (S.ws) settings.lastScript[S.ws.name] = name;
    persist();
  }

  async function saveCurrent() {
    if (!S.ws || !S.ws.writable || S.readonlyDemo) { toast("没有可写的工作区（打开文件夹后才行）"); return; }
    try {
      var text = HW.withUpdatedAt(S.code);
      await S.ws.writeScript(S.current, text);
      S.sources[S.current] = text;
      if (text !== S.code) setCode(text); else S.dirty = false;
      setEditorTitle();
      currentMetaLine();
      buildScriptList();
      toast("已保存 " + S.current + "（自动维护 UPDATED_AT）");
    } catch (e) {
      toast("保存失败：" + (e.message || e));
    }
  }

  /* --------------------------------------------------------- 资源扫描 */

  async function scanResources() {
    Object.keys(S.resUrls).forEach(function (k) { URL.revokeObjectURL(S.resUrls[k]); });
    S.resUrls = {};
    S.res = { files: {}, skipped: [], dirName: "", missing: true };
    if (!S.ws || S.readonlyDemo) { renderResources(); return; }
    try {
      var out = await S.ws.readResources(S.current);
      S.res = out;
    } catch (e) {
      S.res = { files: {}, skipped: [], dirName: "", missing: true, error: e.message || String(e) };
    }
    renderResources();
  }

  function renderResources() {
    var grid = $("res-grid");
    grid.innerHTML = "";
    var note = $("res-note");
    var rels = Object.keys(S.res.files).sort();
    if (S.res.missing) {
      note.textContent = "没有同名资源文件夹（" + (S.res.dirName || "") + "/）——脚本第一次保存或用到资源时 App 会补建";
    } else {
      note.textContent = rels.length + " 个文件" + (S.res.skipped.length ? "（跳过 " + S.res.skipped.length + " 个超 4MB 的）" : "");
    }
    rels.forEach(function (rel) {
      var bytes = S.res.files[rel];
      var kind = HW.workspace.kindOf(rel);
      var card = el("div", "res-card");
      if (kind === "image") {
        var blob = new Blob([bytes], { type: HW.workspace.mimeOf(rel) });
        var url = URL.createObjectURL(blob);
        S.resUrls[rel] = url;
        var img = el("img", "res-thumb");
        img.src = url;
        img.loading = "lazy";
        card.appendChild(img);
      } else {
        card.appendChild(el("div", "res-file", rel.split("/").pop().slice(0, 2).toUpperCase()));
      }
      card.appendChild(el("div", "res-name", rel.split("/").pop()));
      card.title = rel + "（" + Math.round(bytes.length / 1024) + " KB）";
      card.onclick = function () { openLightbox(rel, bytes, kind); };
      grid.appendChild(card);
    });
  }

  function openLightbox(rel, bytes, kind) {
    $("lb-title").textContent = rel;
    var body = $("lb-body");
    body.innerHTML = "";
    if (kind === "image") {
      var img = el("img", "lb-img");
      img.src = S.resUrls[rel];
      body.appendChild(img);
    } else if (kind === "text") {
      var pre = el("pre", "lb-pre");
      pre.textContent = new TextDecoder("utf-8").decode(bytes).slice(0, 20000);
      body.appendChild(pre);
    } else {
      body.appendChild(el("div", "muted", "（二进制文件，暂无预览）"));
    }
    $("lb-meta").textContent = Math.round(bytes.length / 1024) + " KB" + (rel.startsWith("cache/") ? " · cache 缓存文件" : "");
    $("lb-insert").onclick = function () {
      S.editor.insert('ui.image({ path: "' + rel + '" })');
      $("lightbox").hidden = true;
      toast("已插入 ui.image({ path: \"" + rel + "\" })");
    };
    $("lb-copy").onclick = function () {
      navigator.clipboard.writeText(rel).then(function () { toast("已复制路径"); });
    };
    $("lightbox").hidden = false;
  }

  function wireLightbox() {
    $("lb-close").onclick = function () { $("lightbox").hidden = true; };
    $("lightbox").onclick = function (ev) { if (ev.target === $("lightbox")) $("lightbox").hidden = true; };
  }

  /* --------------------------------------------------------- worker */

  function ensureWorker() {
    if (S.worker) return true;
    try {
      S.worker = new Worker("js/worker.js");
      S.worker.onmessage = onWorkerMessage;
      S.worker.onerror = function (e) {
        S.worker = null;
        showError({ phase: "worker", message: "worker 崩溃：" + (e.message || "未知") });
      };
      return true;
    } catch (e) {
      S.worker = null;
      banner("无法创建 worker：" + esc(e.message || e) + "（需要 http 页面）", "warn");
      return false;
    }
  }

  function globalsDeclared() {
    var out = [];
    var seen = {};
    (S.scripts && S.scripts.length ? S.scripts : [S.current]).forEach(function (n) {
      var src = S.sources[n];
      if (src === undefined) return;
      HW.scanDeclarations(src, "GLOBALS").items.forEach(function (it) {
        if (seen[it.key]) return;
        seen[it.key] = 1;
        out.push(it);
      });
    });
    return out;
  }

  function run() {
    if (!ensureWorker()) return;
    clearTimeout(S.watchdog);
    var runId = ++S.runSeq;
    S.watchdog = setTimeout(function () {
      if (S.worker) { S.worker.terminate(); S.worker = null; }
      S.logs = S.logs.concat([{ t: "-", msg: "⏱ 脚本执行超过 8 秒，已强制终止并重建 worker（设备上同理：会被判超时）", level: "warn" }]);
      renderConsole();
      showError({ phase: "timeout", message: "脚本执行超过 8 秒（设备侧 shell/file/http 超时也是 8000ms）" });
    }, 8000);

    var m = meta();
    var presets = HW.scanDeclarations(S.code, "PRESETS").items;
    var envDefaults = {};
    presets.forEach(function (p) { envDefaults[p.key] = p.default; });
    var globalDefaults = {};
    globalsDeclared().forEach(function (g) { globalDefaults[g.key] = g.default; });

    S.worker.postMessage({
      type: "run",
      runId: runId,
      code: S.code,
      scriptName: S.current,
      uiSource: HW.theme.uiSource,
      size: canvas(),
      theme: settings.theme,
      data: settings.data,
      mocks: settings.mocks,
      store: loadStore(S.current),
      envValues: settings.env[S.current] || {},
      envDefaults: envDefaults,
      globalValues: settings.global,
      globalDefaults: globalDefaults,
      resources: S.res.files,
      allowNetwork: settings.allowNetwork,
      httpProxy: settings.httpProxy,
      meta: {
        name: m.name, description: m.description, version: m.version, author: m.author,
        sizes: m.sizes, updatedAt: m.updatedAt,
      },
    });
  }

  async function onWorkerMessage(ev) {
    var msg = ev.data || {};
    if (msg.runId !== S.runSeq) return;   // 旧的一次运行，丢弃
    clearTimeout(S.watchdog);
    S.lastResult = msg;

    if (msg.storeWrites) {
      var st = loadStore(S.current);
      Object.keys(msg.storeWrites).forEach(function (k) {
        if (msg.storeWrites[k] === null) delete st[k];
        else st[k] = msg.storeWrites[k];
      });
      saveStore(S.current, st);
    }
    S.logs = (msg.logs || []).map(function (l) { return String(l); });
    S.warnings = msg.warnings || [];
    renderConsole();

    if (msg.ok) {
      S.error = null;
      await paint(msg.spec);
    } else {
      var err = msg.error || { phase: "unknown", message: "未知错误" };
      err.line = lineFromStack(err.stack);
      showError(err);
    }
    buildDiagnostics(msg);
  }

  /** 从 V8 的堆栈里抠出行号（new Function 会多出 2 行包装，见 README 的说明）。 */
  function lineFromStack(stack) {
    if (!stack) return null;
    var m = /<anonymous>:(\d+):(\d+)/.exec(stack);
    if (!m) m = /:(\d+):(\d+)\)?\s*$/.exec(String(stack).split("\n")[1] || "");
    if (!m) return null;
    var line = Number(m[1]) - 2;
    return line > 0 ? line : null;
  }

  const STORE_KEY = function (name) { return "hw-studio/store/" + name; };
  function loadStore(name) {
    try { return JSON.parse(localStorage.getItem(STORE_KEY(name)) || "{}"); } catch (e) { return {}; }
  }
  function saveStore(name, obj) {
    try { localStorage.setItem(STORE_KEY(name), JSON.stringify(obj)); } catch (e) { }
  }

  /* --------------------------------------------------------- 绘制 */

  async function paint(spec) {
    var stage = $("canvas-scaler");
    if (S.disposing) { try { S.disposing(); } catch (e) { } S.disposing = null; }
    stage.innerHTML = "";
    try {
      var out = await HW.renderer.render(stage, spec, {
        canvas: canvas(),
        resMap: S.res.files,
        density: settings.density,
        scriptName: S.current,
        onTap: function (action, source) {
          toast((source === "card" ? "整卡点击：" : "节点点击：") + describeTap(action), 4200);
        },
      });
      S.disposing = out.dispose;
      S.notes = out.notes || [];
      S.classicNote = out.classicNote;

      // 渲染后量一次尺寸：内容超出安全区在桌面就是被裁掉，这种"少了一截"最难自查
      var canvasEl = stage.querySelector(".wcanvas");
      var contentEl = stage.querySelector(".wcontent");
      if (canvasEl && contentEl) {
        var overH = contentEl.scrollHeight - contentEl.clientHeight;
        var overW = contentEl.scrollWidth - contentEl.clientWidth;
        var free = canvas().h - (spec.bleed ? 0 : 30);
        if (overH > 1) {
          S.notes.push({
            level: "warn",
            msg: "内容比安全区高 " + Math.round(overH) + "dp：桌面上这一段会被裁掉。" +
              "当前画布 " + canvas().h + "dp，" + (spec.bleed ? "出血模式（无安全区）" : "去掉上下各 15dp 安全区") +
              "只剩 " + free + "dp 可用",
          });
        }
        if (overW > 1) {
          S.notes.push({ level: "warn", msg: "内容比安全区宽 " + Math.round(overW) + "dp（横向会被裁，或触发 wrap）" });
        }
      }
    } catch (e) {
      showError({ phase: "render", message: e && e.message ? e.message : String(e) });
      return;
    }
    fitCanvas();
    renderStatus();
  }

  function showError(err) {
    var stage = $("canvas-scaler");
    if (S.disposing) { try { S.disposing(); } catch (e) { } S.disposing = null; }
    HW.renderer.renderError(stage, {
      title: meta().name || null,
      scriptName: S.current,
      message: err.message,
      canvas: canvas(),
    });
    S.error = err;
    fitCanvas();
    renderStatus();
  }

  function fitCanvas() {
    var stage = $("canvas-stage");
    var scaler = $("canvas-scaler");
    var c = canvas();
    var availW = stage.clientWidth - 24;
    var availH = stage.clientHeight - 24;
    var k = Math.min(1, availW / c.w, availH / c.h);
    if (!isFinite(k) || k <= 0) k = 1;
    scaler.style.transform = "scale(" + k + ")";
    scaler.style.width = c.w + "px";
    scaler.style.height = c.h + "px";
    scaler.dataset.scale = String(Math.round(k * 100));
  }
  window.addEventListener("resize", function () { if (S.lastResult) fitCanvas(); });

  function describeTap(action) {
    var a = String(action == null ? "" : action).trim() || "refresh";
    if (a === "none") return "无动作";
    if (a === "refresh") return "立即刷新（重跑脚本）";
    if (a === "config") return "打开脚本选择页（换脚本/换实例绑定）";
    if (a.indexOf("url:hyperwidget://widget-action") === 0) return "改实例变量并立即刷新（点一下换背景那类）";
    if (a.indexOf("url:") === 0) return "打开链接 " + a.slice(4);
    if (a.indexOf("app:") === 0) return "启动应用 " + a.slice(4);
    return "按 refresh 处理（未识别的动作）";
  }

  function renderStatus() {
    var c = canvas();
    var sp = S.lastResult && S.lastResult.ok ? S.lastResult.spec : null;
    var bits = [];
    bits.push("<b>" + c.w + "×" + c.h + "</b> dp");
    bits.push("档位 <b>" + HW.sizeClassOf(c.w, c.h) + "</b>");
    if (sp) {
      bits.push(sp.mode === "tree" ? "布局树 <b>" + (sp.nodeCount || 0) + "</b> 节点" : "经典字段");
      bits.push("刷新 <b>" + sp.refreshSec + "s</b>（最低 15）");
      bits.push("tap <span class='mono'>" + esc(sp.tap) + "</span>");
      if (sp.bleed) bits.push("<b>出血</b>（无安全区）");
    }
    if (S.classicNote) bits.push(esc(S.classicNote));
    if (S.notes && S.notes.length) bits.push("<span class='warn-text'>" + S.notes.length + " 条布局提醒</span>");
    $("status-bar").innerHTML = bits.join(" · ");
    $("canvas-meta").textContent = "显示比例 " + ($("canvas-scaler").dataset.scale || 100) + "%";
  }

  /* --------------------------------------------------------- 面板 */

  function buildSizeSeg() {
    var m = meta();
    var seg = $("size-seg");
    seg.innerHTML = "";
    var declared = m.sizes.filter(function (s) { return HW.SIZE_CLASSES.indexOf(s) >= 0; });
    var list = declared.length ? declared : HW.SIZE_CLASSES;
    seg.title = declared.length
      ? "画布档位（只列脚本 SIZES 里声明过的：" + declared.join(" ") + "）"
      : "脚本没声明 SIZES：App 里整个预览区都不显示（这里仍给三档方便调试）";
    if (!declared.length) {
      seg.classList.add("warn-title");
    } else {
      seg.classList.remove("warn-title");
    }
    if (HW.SIZE_CLASSES.indexOf(settings.sizeClass) < 0) settings.sizeClass = list[0];
    list.forEach(function (s) {
      var b = el("button", "seg-btn" + (s === settings.sizeClass ? " active" : ""), s.replace("x", "×"));
      b.onclick = function () {
        settings.sizeClass = s;
        persist();
        buildSizeSeg();
        run();
      };
      seg.appendChild(b);
    });
  }

  function varRow(title, key, type, value, onChange, onClear) {
    var row = el("div", "var-row");
    var left = el("div", "var-name");
    left.appendChild(el("div", "var-title", title));
    left.appendChild(el("div", "var-key mono", key));
    row.appendChild(left);
    var right = el("div", "var-input");
    if (type === "switch") {
      var lab = el("label", "chk");
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = String(value).toLowerCase() === "true" || value === "1";
      cb.onchange = function () { onChange(cb.checked ? "true" : "false"); };
      lab.appendChild(cb);
      lab.appendChild(el("span", null, "开"));
      right.appendChild(lab);
    } else {
      var inp = document.createElement("input");
      inp.type = "text";
      inp.className = "input";
      inp.value = value == null ? "" : value;
      inp.placeholder = "（空 = 用脚本默认值）";
      inp.oninput = function () { onChange(inp.value); };
      right.appendChild(inp);
    }
    row.appendChild(right);
    var clr = el("button", "mini", "×");
    clr.title = "清除这个覆盖值";
    clr.onclick = function () { onClear(); };
    row.appendChild(clr);
    return row;
  }

  function buildVarsPane() {
    var pane = $("pane-vars");
    pane.innerHTML = "";
    var presetScan = HW.scanDeclarations(S.code, "PRESETS");
    var envVals = settings.env[S.current] || {};
    pane.appendChild(el("h4", null, "脚本参数（PRESETS · ctx.env）"));
    if (!presetScan.items.length) {
      pane.appendChild(el("div", "muted small", "这个脚本没有声明 PRESETS"));
    } else {
      presetScan.items.forEach(function (p) {
        pane.appendChild(varRow(p.title, p.key, p.type, envVals[p.key] !== undefined ? envVals[p.key] : "",
          function (v) {
            settings.env[S.current] = settings.env[S.current] || {};
            settings.env[S.current][p.key] = v;
            persist();
            run();
          },
          function () {
            if (settings.env[S.current]) delete settings.env[S.current][p.key];
            persist();
            buildVarsPane();
            run();
          }));
      });
    }
    if (!presetScan.strictJson) {
      pane.appendChild(el("div", "note warn", "⚠️ PRESETS 不是严格 JSON（注释/尾逗号/单引号）：App 侧 org.json 解析会失败，参数在设备上不生效"));
    }

    pane.appendChild(el("h4", null, "全局变量（GLOBALS · ctx.global）"));
    var declared = globalsDeclared();
    if (!declared.length && !settings.userGlobals.length) {
      pane.appendChild(el("div", "muted small", "工作区里没有脚本声明 GLOBALS"));
    }
    declared.forEach(function (g) {
      pane.appendChild(varRow(g.title, g.key, g.type, settings.global[g.key] !== undefined ? settings.global[g.key] : "",
        function (v) { settings.global[g.key] = v; persist(); run(); },
        function () { delete settings.global[g.key]; persist(); buildVarsPane(); run(); }));
    });
    settings.userGlobals.forEach(function (k) {
      pane.appendChild(varRow(k + "（自建）", k, "text", settings.global[k] !== undefined ? settings.global[k] : "",
        function (v) { settings.global[k] = v; persist(); run(); },
        function () {
          delete settings.global[k];
          settings.userGlobals = settings.userGlobals.filter(function (x) { return x !== k; });
          persist(); buildVarsPane(); run();
        }));
    });
    var add = el("button", "btn ghost small-btn", "+ 自建全局键");
    add.onclick = function () {
      var k = prompt("键名（脚本里用 ctx.global(key) 读）");
      if (!k) return;
      if (settings.userGlobals.indexOf(k) < 0) settings.userGlobals.push(k);
      persist();
      buildVarsPane();
    };
    pane.appendChild(add);
  }

  function numRow(label, value, step, onChange) {
    var row = el("div", "var-row");
    row.appendChild(el("div", "var-name", label));
    var inp = document.createElement("input");
    inp.type = "number";
    inp.className = "input";
    inp.value = value;
    inp.step = step || 1;
    inp.onchange = function () { onChange(Number(inp.value)); };
    row.appendChild(inp);
    return row;
  }
  function textRow(label, value, onChange) {
    var row = el("div", "var-row");
    row.appendChild(el("div", "var-name", label));
    var inp = document.createElement("input");
    inp.type = "text";
    inp.className = "input";
    inp.value = value;
    inp.onchange = function () { onChange(inp.value); };
    row.appendChild(inp);
    return row;
  }
  function switchRow(label, value, onChange) {
    var row = el("div", "var-row");
    row.appendChild(el("div", "var-name", label));
    var lab = el("label", "chk");
    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!value;
    cb.onchange = function () { onChange(cb.checked); };
    lab.appendChild(cb);
    row.appendChild(lab);
    return row;
  }

  function buildDataPane() {
    var pane = $("pane-data");
    pane.innerHTML = "";
    var b = settings.data.battery, d = settings.data.device;

    // 主题来源（三态）：直读 App 仓库 / 主题快照 / 内置兜底
    pane.appendChild(el("h4", null, "主题来源"));
    var srcRow = el("div", "var-row");
    srcRow.appendChild(el("div", "var-name", "当前来源"));
    var srcVal = el("div", "var-input mono small", HW.theme.sourceLabel());
    srcRow.appendChild(srcVal);
    pane.appendChild(srcRow);
    (HW.theme.notes || []).forEach(function (n) {
      pane.appendChild(el("div", "note", n));
    });
    if (HW.theme.snapshot && HW.theme.source === "snapshot") {
      pane.appendChild(el("div", "muted small",
        "线上版读不到私有的 App 仓库，令牌/图标/组件库来自提交进本仓库的快照。" +
        "改了 App 的 res/ 或 widget-ui.js 之后，在本仓库跑一次 " +
        "<span class='mono'>node tools/sync-studio-assets.mjs --app &lt;App 仓库&gt;</span> 并提交。"));
    }
    pane.appendChild(textRow("仓库地址（本地开发/直读 res，留空=自动探测）", settings.repoBase, function (v) {
      settings.repoBase = v.trim();
      persist();
      HW.theme.load(settings.repoBase).then(function () {
        applyTheme();
        buildDataPane();
        if (S.editor && S.editor.setTheme) S.editor.setTheme(settings.theme);
        run();
        toast("主题来源：" + HW.theme.sourceLabel());
      });
    }));
    var probe = el("button", "btn ghost small-btn", "重新探测并重载主题");
    probe.onclick = function () {
      HW.theme.load(settings.repoBase || "").then(function () {
        applyTheme();
        buildDataPane();
        run();
        toast("主题来源：" + HW.theme.sourceLabel());
      });
    };
    pane.appendChild(probe);

    pane.appendChild(el("h4", null, "电量（ctx.battery）"));
    pane.appendChild(numRow("电量 %", b.level, 1, function (v) { b.level = v; persist(); run(); }));
    pane.appendChild(switchRow("充电中 charging", b.charging, function (v) { b.charging = v; persist(); run(); }));
    pane.appendChild(switchRow("插着电源 plugged", b.plugged, function (v) { b.plugged = v; persist(); run(); }));
    pane.appendChild(numRow("电流 mA currentMa", b.currentMa, 1, function (v) { b.currentMa = v; persist(); run(); }));
    pane.appendChild(numRow("电压 V voltageV", b.voltageV, 0.01, function (v) { b.voltageV = v; persist(); run(); }));
    pane.appendChild(numRow("温度 ℃ tempC", b.tempC, 0.1, function (v) { b.tempC = v; persist(); run(); }));
    var power = (Number(b.currentMa) / 1000) * Number(b.voltageV);
    pane.appendChild(el("div", "muted small", "powerW 由公式算出：" + power.toFixed(2) + " W"));

    pane.appendChild(el("h4", null, "设备（ctx.device / ctx.meta）"));
    pane.appendChild(textRow("型号 model", d.model, function (v) { d.model = v; persist(); run(); }));
    pane.appendChild(textRow("Android 版本", d.androidVersion, function (v) { d.androidVersion = v; persist(); run(); }));
    pane.appendChild(el("div", "muted small", "ctx.meta().widgetId = -100（应用内预览的虚拟实例号），isPreview = true"));

    pane.appendChild(el("h4", null, "画布（dp = 桌面真实上报值）"));
    HW.SIZE_CLASSES.forEach(function (s) {
      var row = el("div", "var-row");
      row.appendChild(el("div", "var-name", s.replace("x", "×")));
      var wrap = el("div", "pair");
      var wi = document.createElement("input");
      wi.type = "number"; wi.className = "input"; wi.value = settings.canvas[s].w;
      wi.onchange = function () { settings.canvas[s].w = Number(wi.value); persist(); buildSizeSeg(); run(); };
      var hi = document.createElement("input");
      hi.type = "number"; hi.className = "input"; hi.value = settings.canvas[s].h;
      hi.onchange = function () { settings.canvas[s].h = Number(hi.value); persist(); run(); };
      wrap.appendChild(wi);
      wrap.appendChild(el("span", "muted", "×"));
      wrap.appendChild(hi);
      row.appendChild(wrap);
      pane.appendChild(row);
    });
    pane.appendChild(el("div", "muted small", "默认值是真机实测的上报值（4×2 = 350×166、4×4 = 350×365）。" +
      "桌面按格子算，4×2 比 manifest 里的名义值（326×163）大一圈。"));
    pane.appendChild(numRow("渲染密度 density", settings.density, 1, function (v) { settings.density = v || 3; persist(); run(); }));

    pane.appendChild(el("h4", null, "网络 / 命令"));
    pane.appendChild(switchRow("允许真实网络（ctx.http / httpBinary）", settings.allowNetwork, function (v) { settings.allowNetwork = v; persist(); run(); }));
    pane.appendChild(textRow("HTTP 代理前缀（绕过 CORS，留空=直连）", settings.httpProxy, function (v) { settings.httpProxy = v; persist(); run(); }));

    pane.appendChild(el("h4", null, "mock 表（JSON：键 → 返回值）"));
    pane.appendChild(el("div", "muted small",
      "键名：<span class='mono'>shell:命令</span> / <span class='mono'>http:URL</span>（返回文本）/ " +
      "<span class='mono'>httpbin:URL</span>（返回 base64）。命中即优先，不真的发请求。"));
    var ta = document.createElement("textarea");
    ta.className = "ed-textarea mock-ta";
    ta.value = settings.mocksText;
    var apply = el("button", "btn ghost small-btn", "应用 mock 表");
    apply.onclick = function () {
      try {
        var obj = JSON.parse(ta.value || "{}");
        settings.mocksText = ta.value;
        settings.mocks = obj;
        persist();
        toast("mock 表已应用（" + Object.keys(obj).length + " 条）");
        run();
      } catch (e) {
        toast("JSON 解析失败：" + e.message);
      }
    };
    pane.appendChild(ta);
    pane.appendChild(apply);
  }

  function renderConsole() {
    var box = $("pane-console");
    box.innerHTML = "";
    if (!S.logs.length && !S.warnings.length) {
      box.appendChild(el("div", "muted small", "ctx.log() 的输出会出现在这里"));
      return;
    }
    S.logs.forEach(function (line) {
      box.appendChild(el("div", "log-line", line));
    });
    S.warnings.forEach(function (w) {
      box.appendChild(el("div", "log-line warn", "⚠ " + w));
    });
  }

  function issueRow(line, level, msg) {
    var li = el("li", "issue " + (level === "error" ? "err" : "warn"));
    if (line) {
      var ln = el("span", "issue-line mono", "行 " + line);
      ln.onclick = function () { if (S.editor && S.editor.reveal) S.editor.reveal(line); };
      li.appendChild(ln);
    }
    li.appendChild(el("span", "issue-msg", msg));
    return li;
  }

  /** 汇总所有诊断：脚本错误 / 布局提醒 / Rhino 兼容 / 元数据规范。 */
  function buildDiagnostics(msg) {
    var list = [];
    if (S.error) list.push({ level: "error", line: S.error.line, msg: S.error.message });
    (S.notes || []).forEach(function (n) { list.push({ level: n.level || "warn", msg: n.msg }); });
    S.warnings.forEach(function (w) { list.push({ level: "warn", msg: w }); });

    HW.scanRhinoRisks(S.code).forEach(function (r) {
      list.push({ level: r.level, line: r.line, msg: "Rhino 兼容：" + r.msg });
    });

    var m = meta();
    if (m.declared && m.missingRequired.length) {
      list.push({ level: "warn", msg: "元数据缺 " + m.missingRequired.join("、") + "（脚本列表与市场页显示会受影响）" });
    }
    if (!m.versionValid) list.push({ level: "warn", msg: "VERSION 不是 semver（应形如 1.0.0）" });
    if (!m.minEngineSatisfied) list.push({ level: "error", msg: "MIN_ENGINE=" + m.minEngine + " 高于当前规范 " + HW.ENGINE_SPEC });
    if (msg && msg.ok && msg.spec && msg.spec.rows && msg.spec.rows.length && msg.spec.mode === "classic" && S.classicNote) {
      list.push({ level: "warn", msg: S.classicNote });
    }

    // 编辑器内联标记（只有带行号的才标）
    if (S.editor) S.editor.setDiagnostics(list.filter(function (d) { return d.line; }));

    var ul = $("pane-diag");
    ul.innerHTML = "";
    if (!list.length) {
      ul.appendChild(el("li", "muted", "没有发现问题"));
    } else {
      list.forEach(function (d) { ul.appendChild(issueRow(d.line, d.level, d.msg)); });
    }

    var ic = $("issues-count");
    var errs = list.filter(function (d) { return d.level === "error"; }).length;
    ic.hidden = !list.length;
    ic.textContent = errs ? (errs + " 错误 / " + list.length + " 条") : (list.length + " 条提醒");
    ic.className = "badge" + (errs ? " err" : "");

    var il = $("issues-list");
    il.innerHTML = "";
    if (!list.length) il.appendChild(el("li", "muted", "—"));
    else list.slice(0, 12).forEach(function (d) { il.appendChild(issueRow(d.line, d.level, d.msg)); });
  }

  /* --------------------------------------------------------- 交互 */

  function onCodeChange(text) {
    S.code = text;
    if (S.loadingCode) return;          // setCode() 灌入的内容不算"用户修改"
    if (!S.dirty) { S.dirty = true; setEditorTitle(); }
    currentMetaLine();
    buildSizeSeg();
    if (!settings.auto) return;
    clearTimeout(S.timer);
    S.timer = setTimeout(function () { run(); }, 400);
  }

  function wireTabs() {
    var tabs = $("tabs");
    tabs.addEventListener("click", function (ev) {
      var b = ev.target.closest(".tab");
      if (!b) return;
      Array.prototype.forEach.call(tabs.children, function (x) { x.classList.toggle("active", x === b); });
      Array.prototype.forEach.call(document.querySelectorAll(".tabpane"), function (p) {
        p.classList.toggle("active", p.dataset.pane === b.dataset.tab);
      });
    });
  }

  function wireToolbar() {
    $("btn-open").onclick = function (ev) {
      if (ev.ctrlKey || ev.altKey || !HW.workspace.supported) $("file-fallback").click();
      else openFolder();
    };
    $("file-fallback").onchange = async function (ev) {
      if (!ev.target.files || !ev.target.files.length) return;
      S.ws = await HW.workspace.fromFileList(ev.target.files);
      await afterWorkspace();
    };
    $("btn-save").onclick = saveCurrent;
    $("btn-run").onclick = run;
    $("btn-new").onclick = async function () {
      var name = prompt("新脚本文件名（要带 .js）", "新脚本.js");
      if (!name) return;
      if (!/\.js$/i.test(name)) name += ".js";
      try {
        await S.ws.createScript(name, HW.workspace.scaffold(name));
        await afterWorkspace();
        await switchTo(name);
        toast("已创建 " + name);
      } catch (e) {
        toast("创建失败：" + (e.message || e));
      }
    };
    $("btn-res-refresh").onclick = function () { scanResources(); };
    $("btn-theme").onclick = function () {
      settings.theme = settings.theme === "dark" ? "light" : "dark";
      persist();
      applyTheme();
      if (S.editor && S.editor.setTheme) S.editor.setTheme(settings.theme);
      run();
    };
    $("script-select").onchange = function (ev) { switchTo(ev.target.value); };
    $("chk-auto").onchange = function (ev) {
      settings.auto = ev.target.checked;
      persist();
      if (settings.auto) run();
    };
    $("chk-wrap").onchange = function (ev) {
      settings.wrap = ev.target.checked;
      persist();
      if (S.editor) S.editor.setWrap(settings.wrap);
    };
    document.addEventListener("keydown", function (ev) {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
        ev.preventDefault();
        saveCurrent();
      }
      if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") {
        ev.preventDefault();
        run();
      }
    });
  }

  /**
   * 控制台调试入口（F12 里用）：HW.studio.getCode() / setCode(src) / run() / save() / settings
   * 例：HW.studio.setCode("function render(ctx){ return { title: 'hi' } }")
   */
  HW.studio = {
    state: S,
    getCode: function () { return S.code; },
    setCode: function (src) { setCode(src); run(); },
    run: run,
    save: saveCurrent,
    settings: settings,
  };
})();
