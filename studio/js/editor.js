/*
 * ============================================================================
 *  小部件设计工具 · 编辑器（Monaco = 微软开源的那套，VS Code 同款内核）
 * ============================================================================
 *  加载顺序（全自动回退，任何一步失败都不会白屏，也不会拖慢预览）：
 *    1. vendor/monaco/vs              本地自带（离线/内网可用，见 README）
 *    2. registry.npmmirror.com        国内最快（实测冷启 ~5s、热 ~0.2s，且带 CORS）
 *    3. cdn.jsdelivr.net              → 4. fastly.jsdelivr.net → 5. unpkg.com
 *    6. 纯 textarea                   （仍然可编辑、可预览、可保存，只是没高亮/补全）
 *  每个源最多等 5 秒（unpkg 在部分网络下会挂住 8s+ 不返回，不能让它拖住启动）。
 *
 *  同时给 JS 语言服务注入 hw.d.ts：ctx / ui / 节点属性都能补全，
 *  令牌名（primary/secondary/accent）写成联合类型，写错立刻报红线。
 * ============================================================================
 */
(function (root) {
  "use strict";
  var HW = (root.HW = root.HW || {});

  var MONACO_VERSION = "0.52.2";
  var SOURCE_TIMEOUT_MS = 5000;
  var BASES = [
    "vendor/monaco",
    "https://registry.npmmirror.com/monaco-editor/" + MONACO_VERSION + "/files/min",
    "https://cdn.jsdelivr.net/npm/monaco-editor@" + MONACO_VERSION + "/min",
    "https://fastly.jsdelivr.net/npm/monaco-editor@" + MONACO_VERSION + "/min",
    "https://unpkg.com/monaco-editor@" + MONACO_VERSION + "/min",
  ];

  var DTS = [
    "/** 小部件设计工具：引擎注入的全局对象（对应 App 里的 JsBridge） */",
    "declare const ctx: HWCtx;",
    "declare const ui: HWUi;",
    "declare function render(ctx: HWCtx): HWSpec;",
    "",
    "interface HWSize { w: number; h: number; }",
    "interface HWBattery { level: number; charging: boolean; plugged: boolean; currentMa: number; voltageV: number; tempC: number; powerW: number; }",
    "interface HWMeta { name: string | null; description: string | null; version: string | null; author: string | null; sizes: string[]; updatedAt: string | null; widgetId: number; isPreview: boolean; }",
    "interface HWDevice { model: string; androidVersion: string; isDarkMode: boolean; }",
    "interface HWHttpResult { status: number; ok: boolean; body: string; }",
    "interface HWHttpOptions { url: string; method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD'; headers?: Record<string, string>; body?: string; }",
    "",
    "interface HWCtx {",
    "  battery(): HWBattery;",
    "  /** Java SimpleDateFormat 子集：HH mm ss yyyy MM dd E a 等 */",
    "  time(pattern?: string): string;",
    "  uptime(): number;",
    "  /** 脚本资源文件夹内的相对路径（网页里读同一文件夹） */",
    "  file(path: string, root?: boolean): string;",
    "  shell(cmd: string, root?: boolean): string;",
    "  http(url: string): string;",
    "  http(options: HWHttpOptions): HWHttpResult;",
    "  httpBinary(url: string): string;",
    "  json(text: string): any;",
    "  log(msg: any): void;",
    "  storeGet(key: string): string | null;",
    "  storeSet(key: string, value: any): void;",
    "  /** 脚本参数（PRESETS） */",
    "  env(key: string, fallback?: string): string | null;",
    "  /** 全局变量（GLOBALS，所有脚本共用） */",
    "  global(key: string, fallback?: string): string | null;",
    "  /** 脚本参数 → 全局变量 → fallback */",
    "  var(key: string, fallback?: string): string | null;",
    "  size(): HWSize;",
    "  /** '2x2' | '4x2' | '4x4' | 'unknown' */",
    "  sizeClass(): string;",
    "  meta(): HWMeta;",
    "  device(): HWDevice;",
    "}",
    "",
    "/** 布局节点（LayoutNode 白名单 12 种） */",
    "interface HWNode {",
    "  type: 'column' | 'row' | 'stack' | 'grid' | 'box' | 'spacer' | 'text' | 'icon' | 'image' | 'progress' | 'clock' | 'chrono';",
    "  w?: number | 'match' | 'wrap';",
    "  h?: number | 'match' | 'wrap';",
    "  padding?: number;",
    "  /** 仅 column/row；token: left/start right/end top bottom center center_horizontal center_vertical */",
    "  gravity?: string;",
    "  /** 仅 column/row：相邻子项间距（dp） */",
    "  gap?: number;",
    "  tap?: 'refresh' | 'config' | 'none' | `url:${string}` | `app:${string}`;",
    "  children?: HWNode[];",
    "  color?: 'primary' | 'secondary' | 'accent';",
    "  bg?: 'surface' | 'card' | 'accent' | 'none';",
    "  radius?: number;",
    "  size?: number;",
    "  bold?: boolean;",
    "  maxLines?: number;",
    "  align?: 'start' | 'center' | 'end' | 'right';",
    "  text?: string;",
    "  name?: 'check' | 'close' | 'add' | 'remove' | 'arrow_up' | 'arrow_down' | 'favorite' | 'star' | 'bolt' | 'wifi' | 'battery' | 'clock' | 'circle' | 'square' | 'triangle' | 'dot' | 'drop' | 'sun' | 'moon';",
    "  format?: string;",
    "  timeZone?: string;",
    "  base?: number;",
    "  running?: boolean;",
    "  countdown?: boolean;",
    "  value?: number;",
    "  max?: number;",
    "  cols?: number;",
    "  path?: string;",
    "  url?: string;",
    "  res?: string;",
    "  b64?: string;",
    "  file?: string;",
    "  uri?: boolean;",
    "  mode?: 'crop' | 'stretch';",
    "  paneltop?: number;",
    "  panelinset?: number;",
    "  fade?: number;",
    "  round?: number;",
    "  corner?: number;",
    "}",
    "",
    "interface HWSpec {",
    "  layout?: HWNode;",
    "  title?: string;",
    "  chip?: string;",
    "  big?: string;",
    "  rows?: [string, string][];",
    "  progress?: { value: number; max: number };",
    "  tap?: string;",
    "  /** 秒，最低 15 */",
    "  refresh?: number;",
    "  /** 出血：内容铺满整块（无 15dp 安全区） */",
    "  bleed?: boolean;",
    "}",
    "",
    "interface HWUi {",
    "  VERSION: string;",
    "  text(text: any, opts?: HWNode): HWNode;",
    "  icon(name: HWNode['name'], opts?: HWNode): HWNode;",
    "  image(source: string | Partial<HWNode>, opts?: Partial<HWNode>): HWNode;",
    "  progress(value: number, max: number, opts?: HWNode): HWNode;",
    "  clock(opts?: HWNode): HWNode;",
    "  chrono(opts?: HWNode): HWNode;",
    "  spacer(w?: number, h?: number): HWNode;",
    "  column(children?: HWNode[], opts?: HWNode): HWNode;",
    "  row(children?: HWNode[], opts?: HWNode): HWNode;",
    "  stack(children?: HWNode[], opts?: HWNode): HWNode;",
    "  box(children?: HWNode[], opts?: HWNode): HWNode;",
    "  grid(cols: number, children?: HWNode[], opts?: HWNode): HWNode;",
    "  titleBar(opts?: { icon?: HWNode['name']; title?: string; trailing?: string; size?: number; iconSize?: number; iconColor?: HWNode['color']; color?: HWNode['color']; trailingColor?: HWNode['color']; gap?: number; tap?: string }): HWNode;",
    "  chip(text: any, opts?: HWNode): HWNode;",
    "  label(text: any, opts?: HWNode): HWNode;",
    "  iconStat(opts?: { icon?: HWNode['name']; value?: any; label?: string; size?: number; labelSize?: number; iconSize?: number; iconColor?: HWNode['color']; color?: HWNode['color']; gap?: number; align?: string }): HWNode;",
    "  bigNumber(value: any, opts?: { unit?: string; size?: number; unitSize?: number; color?: HWNode['color']; unitColor?: HWNode['color']; gap?: number }): HWNode;",
    "  kvRow(label: any, value: any, opts?: HWNode): HWNode;",
    "  kvRows(rows: Array<[any, any] | { label: any; value: any }>, opts?: HWNode): HWNode;",
    "  gauge(opts?: { value?: number; max?: number; label?: string; text?: string; color?: HWNode['color']; gap?: number }): HWNode;",
    "  barChart(opts?: { values?: number[]; labels?: string[]; max?: number; height?: number; barWidth?: number; gap?: number; bg?: HWNode['bg'] }): HWNode;",
    "  statRow(items: Array<{ value: any; label?: string }>, opts?: { size?: number; labelSize?: number; color?: HWNode['color']; gap?: number }): HWNode;",
    "  card(children?: HWNode[], opts?: HWNode): HWNode;",
    "  divider(opts?: HWNode): HWNode;",
    "}",
  ].join("\n");

  /* ---------------------------------------------------------------- Monaco */

  /** 载入一个脚本，带超时（挂住的源不能拖住启动）。 */
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var s = document.createElement("script");
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        s.remove();
        reject(new Error("超时 " + Math.round(SOURCE_TIMEOUT_MS / 1000) + "s"));
      }, SOURCE_TIMEOUT_MS);
      s.src = src;
      s.onload = function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(src);
      };
      s.onerror = function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        s.remove();
        reject(new Error("加载失败"));
      };
      document.head.appendChild(s);
    });
  }

  async function loadMonaco() {
    var reasons = [];
    for (var i = 0; i < BASES.length; i++) {
      var base = BASES[i];
      var abs = new URL(base, location.href).href;
      try {
        await loadScript(abs + "/vs/loader.js");
      } catch (e) {
        reasons.push(base.replace(/^https:\/\//, "").split("/")[0] + ": " + e.message);
        continue;
      }
      try {
        await new Promise(function (resolve, reject) {
          var timer = setTimeout(function () { reject(new Error("require 超时")); }, 20000);
          /* global require */
          window.require.config({ paths: { vs: abs + "/vs" } });
          window.require(["vs/editor/editor.main"], function (m) {
            clearTimeout(timer);
            resolve(m);
          }, function (err) {
            clearTimeout(timer);
            reject(err);
          });
        });
        if (window.monaco) return { monaco: window.monaco, base: base, reasons: reasons };
      } catch (e2) {
        reasons.push(base.replace(/^https:\/\//, "").split("/")[0] + ": 编辑器主体加载失败");
      }
    }
    return { monaco: null, base: null, reasons: reasons };
  }

  /* ------------------------------------------------------------ textarea 兜底 */

  function createFallback(container, onChange) {
    var wrap = document.createElement("div");
    wrap.className = "ed-fallback";
    var ta = document.createElement("textarea");
    ta.spellcheck = false;
    ta.className = "ed-textarea";
    wrap.appendChild(ta);
    container.appendChild(wrap);
    ta.addEventListener("input", function () { onChange(ta.value); });
    return {
      kind: "textarea",
      setValue: function (v) { ta.value = v; },
      getValue: function () { return ta.value; },
      insert: function (text) {
        var s = ta.selectionStart, e = ta.selectionEnd;
        ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
        ta.selectionStart = ta.selectionEnd = s + text.length;
        onChange(ta.value);
        ta.focus();
      },
      setDiagnostics: function () { },
      reveal: function (line) {
        var lines = ta.value.split("\n");
        var pos = 0;
        for (var i = 0; i < Math.min(line - 1, lines.length); i++) pos += lines[i].length + 1;
        ta.focus();
        ta.setSelectionRange(pos, pos + (lines[line - 1] || "").length);
      },
      setWrap: function (on) { ta.wrap = on ? "soft" : "off"; ta.style.whiteSpace = on ? "pre-wrap" : "pre"; },
      focus: function () { ta.focus(); },
      dispose: function () { wrap.remove(); },
    };
  }

  /* ------------------------------------------------------------------ 出口 */

  HW.editor = {
    /**
     * 创建编辑器。onChange(text) 在内容变化时调用。
     * 返回 { kind, setValue, getValue, insert, setDiagnostics, setWrap, focus, dispose, setLanguage }
     */
    create: async function (container, onChange, opts) {
      opts = opts || {};
      var loaded = null;
      try {
        loaded = await loadMonaco();
      } catch (e) {
        loaded = { monaco: null, reasons: [String(e && e.message || e)] };
      }
      if (!loaded || !loaded.monaco) {
        var fb = createFallback(container, onChange);
        fb.note = "Monaco 未能加载（本地 vendor 与 4 个 CDN 都不可达）——已退回纯文本编辑，预览与保存不受影响。" +
          "原因：" + ((loaded && loaded.reasons) || []).join("；") +
          "。要离线可用：把 monaco-editor/min 放到 tools/widget-studio/vendor/monaco/（README 有说明）。";
        return fb;
      }
      var monaco = loaded.monaco;
      var base = loaded.base;
      try {
        monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
          target: monaco.languages.typescript.ScriptTarget.ES2017,
          allowNonTsExtensions: true,
          checkJs: true,
          noEmit: true,
        });
        monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
          noSemanticValidation: false,
          noSyntaxValidation: false,
          // 1108/1375/1378/2304/2552：Rhino 风格脚本里的"未定义/重复声明"噪声，交给工具的
          // Rhino 兼容面板去说，不用红波浪淹掉真正的语法错
          diagnosticCodesToIgnore: [1108, 1375, 1378, 2304, 2552, 2669, 2451],
        });
        monaco.languages.typescript.javascriptDefaults.addExtraLib(DTS, "hw.d.ts");
      } catch (e) {
        /* 语言服务不可用不影响编辑 */
      }

      var editor = monaco.editor.create(container, {
        value: "",
        language: "javascript",
        theme: opts.theme === "dark" ? "vs-dark" : "vs",
        automaticLayout: true,
        fontSize: 13,
        lineHeight: 20,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        tabSize: 2,
        renderWhitespace: "none",
        wordWrap: opts.wrap === false ? "off" : "on",
        fixedOverflowWidgets: true,
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      });
      var sub = editor.onDidChangeModelContent(function () { onChange(editor.getValue()); });

      return {
        kind: "monaco",
        raw: editor,
        source: base,
        setValue: function (v) { editor.setValue(v); },
        getValue: function () { return editor.getValue(); },
        insert: function (text) {
          var sel = editor.getSelection();
          editor.executeEdits("studio", [{ range: sel, text: text, forceMoveMarkers: true }]);
          editor.focus();
        },
        setDiagnostics: function (list) {
          var model = editor.getModel();
          if (!model) return;
          monaco.editor.setModelMarkers(model, "hw", (list || []).map(function (d) {
            return {
              severity: d.level === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
              message: d.msg,
              startLineNumber: d.line || 1,
              startColumn: 1,
              endLineNumber: d.line || 1,
              endColumn: 200,
            };
          }));
        },
        setWrap: function (on) { editor.updateOptions({ wordWrap: on ? "on" : "off" }); },
        reveal: function (line) {
          editor.revealLineInCenter(line);
          editor.setPosition({ lineNumber: line, column: 1 });
          editor.focus();
        },
        setTheme: function (mode) { monaco.editor.setTheme(mode === "dark" ? "vs-dark" : "vs"); },
        focus: function () { editor.focus(); },
        dispose: function () { sub.dispose(); editor.dispose(); },
      };
    },
  };
})(typeof self !== "undefined" ? self : globalThis);
