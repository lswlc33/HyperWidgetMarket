/*
 * ============================================================================
 *  小部件设计工具 · 语义层（主线程 + worker 共用）
 * ============================================================================
 *  这里是 App 引擎的 JS 移植，**唯一职责**：让网页里的「脚本能跑通 / 报错一致 /
 *  元数据一致」与设备上完全相同。逐条对照：
 *    - ScriptMeta.kt        → HW.scanMeta / HW.withUpdatedAt
 *    - ScriptPreset.kt      → HW.scanDeclarations
 *    - LayoutNode.java      → HW.parseSpec（白名单、上限、令牌、gravity/grow 拦截）
 *    - RenderSpec.java      → HW.parseSpec（refresh 钳 15、rows 上限 4、tap 回落）
 *    - ScriptStore.kt       → HW.cacheFileName / HW.sizeClassOf
 *
 *  ⚠️ 改这些 Java/Kotlin 文件时，这个文件要同步改（docs/网页设计工具计划.md §8）。
 *  渲染部分（prim_*.xml 的尺寸语义）在 js/render.js，不在这里。
 * ============================================================================
 */
(function (root) {
  "use strict";
  var HW = (root.HW = root.HW || {});

  /* ------------------------------------------------------------------ 常量 */

  /** LayoutNode.TYPES —— 节点类型白名单。 */
  HW.NODE_TYPES = [
    "column", "row", "stack", "grid", "box", "spacer",
    "text", "icon", "image", "progress", "clock", "chrono",
  ];
  HW.MAX_NODES = 80;
  HW.MAX_DEPTH = 6;
  /** 只有 LinearLayout 有 setGravity，见 LayoutNode.GRAVITY_TYPES。 */
  HW.GRAVITY_TYPES = ["column", "row"];
  /** 颜色令牌白名单（LayoutNode.COLOR_KEYS）。 */
  HW.COLOR_TOKENS = {
    text: ["primary", "secondary", "accent"],
    icon: ["primary", "secondary", "accent"],
    clock: ["primary", "secondary", "accent"],
    chrono: ["primary", "secondary", "accent"],
    box: ["surface", "card", "accent", "none"],
  };
  /** WidgetRenderer.ICON_NAMES —— 内置矢量图标（res/drawable/ic_w_*.xml）。 */
  HW.ICON_NAMES = [
    "check", "close", "add", "remove", "arrow_up", "arrow_down",
    "favorite", "star", "bolt", "wifi", "battery", "clock",
    "circle", "square", "triangle", "dot", "drop", "sun", "moon",
  ];
  /** ScriptMeta.ENGINE_SPEC —— 当前脚本规范版本。 */
  HW.ENGINE_SPEC = "1.0";
  /** 三档尺寸；画布默认值取真机实测上报值（可在设置里改）。 */
  HW.SIZE_CLASSES = ["2x2", "4x2", "4x4"];
  HW.DEFAULT_CANVAS = {
    "2x2": { w: 163, h: 163 },
    "4x2": { w: 350, h: 166 },
    "4x4": { w: 350, h: 365 },
  };

  /* -------------------------------------------------------------- 通用工具 */

  var util = (HW.util = {});

  util.utf8 = function (str) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str);
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  };

  var MD5_K = null;
  function md5K() {
    if (!MD5_K) {
      MD5_K = new Uint32Array(64);
      for (var i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
    }
    return MD5_K;
  }
  function safeAdd(x, y) {
    var lsw = (x & 0xffff) + (y & 0xffff);
    var msw = (x >> 16) + (y >> 16) + (lsw >> 16);
    return (msw << 16) | (lsw & 0xffff);
  }
  function rol(num, cnt) { return (num << cnt) | (num >>> (32 - cnt)); }
  function cmn(q, a, b, x, s, t) { return safeAdd(rol(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b); }

  /** MD5（输入字节 → 32 位小写十六进制），对齐 Java MessageDigest。 */
  util.md5 = function (bytes) {
    var K = md5K();
    var msglen = bytes.length;
    var withPad = new Uint8Array((((msglen + 8) >> 6) + 1) << 6);
    withPad.set(bytes);
    withPad[msglen] = 0x80;
    var bits = msglen * 8;
    var dv = new DataView(withPad.buffer);
    dv.setUint32(withPad.length - 8, bits >>> 0, true);
    dv.setUint32(withPad.length - 4, Math.floor(bits / 4294967296), true);

    var a0 = 1732584193, b0 = -271733879, c0 = -1732584194, d0 = 271733878;
    var S = [
      [7, 12, 17, 22], [5, 9, 14, 20], [4, 11, 16, 23], [6, 10, 15, 21],
    ];
    var M = new Int32Array(16);
    for (var off = 0; off < withPad.length; off += 64) {
      for (var i = 0; i < 16; i++) M[i] = dv.getInt32(off + i * 4, true);
      var a = a0, b = b0, c = c0, d = d0;
      for (var r = 0; r < 64; r++) {
        var round = r >> 4;
        var g = round === 0 ? r : round === 1 ? (5 * r + 1) & 15
          : round === 2 ? (3 * r + 5) & 15 : (7 * r) & 15;
        var f = round === 0 ? ((b & c) | (~b & d))
          : round === 1 ? ((b & d) | (c & ~d))
            : round === 2 ? (b ^ c ^ d) : (c ^ (b | ~d));
        var tmp = d; d = c; c = b;
        b = cmn(f, a, b, M[g], S[round][r & 3], K[r]);
        a = tmp;
      }
      a0 = safeAdd(a0, a); b0 = safeAdd(b0, b); c0 = safeAdd(c0, c); d0 = safeAdd(d0, d);
    }
    function hex(n) {
      var s = "";
      for (var i = 0; i < 4; i++) s += ((n >> (i * 8)) & 0xff).toString(16).padStart(2, "0");
      return s;
    }
    return hex(a0) + hex(b0) + hex(c0) + hex(d0);
  };

  /**
   * ScriptStore.cacheFileName —— 在线资源的缓存文件名：<MD5 前 10 位>-<URL 末段>。
   * 工具用它去脚本资源文件夹的 cache/ 里找**真机下载过的**缓存文件，
   * 这样换背景、头像这类在线图在网页里也能离线预览。
   */
  util.cacheFileName = function (url) {
    var hash = util.md5(util.utf8(url)).slice(0, 10);
    var afterSlash = url.split("/").pop().split("?")[0] || "";
    var safe = afterSlash.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40) || "cache";
    return hash + "-" + safe;
  };

  var WEEK_SHORT = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  var WEEK_LONG = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

  /**
   * Java SimpleDateFormat 的常用子集（ctx.time / clock 节点的 format 用）。
   * 支持 yyyy yy MM M dd d HH H hh h mm m ss s SSS EEEE EEE EE E a 与字面量引号，
   * 其余字母原样输出——写错了在网页上也能看出是原样输出，不会静默变成别的值。
   */
  util.formatTime = function (pattern, date) {
    var d = date || new Date();
    var p = pattern && String(pattern).trim() ? String(pattern) : "HH:mm";
    var out = "";
    var i = 0;
    function pad(n, w) { return String(n).padStart(w || 2, "0"); }
    var map = {
      yyyy: function () { return pad(d.getFullYear(), 4); },
      yy: function () { return pad(d.getFullYear() % 100); },
      MM: function () { return pad(d.getMonth() + 1); },
      M: function () { return String(d.getMonth() + 1); },
      dd: function () { return pad(d.getDate()); },
      d: function () { return String(d.getDate()); },
      HH: function () { return pad(d.getHours()); },
      H: function () { return String(d.getHours()); },
      hh: function () { return pad(d.getHours() % 12 || 12); },
      h: function () { return String(d.getHours() % 12 || 12); },
      mm: function () { return pad(d.getMinutes()); },
      m: function () { return String(d.getMinutes()); },
      ss: function () { return pad(d.getSeconds()); },
      s: function () { return String(d.getSeconds()); },
      SSS: function () { return pad(d.getMilliseconds(), 3); },
      EEEE: function () { return WEEK_LONG[d.getDay()]; },
      EEE: function () { return WEEK_SHORT[d.getDay()]; },
      EE: function () { return WEEK_SHORT[d.getDay()]; },
      E: function () { return WEEK_SHORT[d.getDay()]; },
      a: function () { return d.getHours() < 12 ? "上午" : "下午"; },
      Z: function () {
        var off = -d.getTimezoneOffset();
        var sign = off < 0 ? "-" : "+";
        off = Math.abs(off);
        return sign + pad(Math.floor(off / 60)) + pad(off % 60);
      },
    };
    var letters = "yMdHhmsESZa";
    while (i < p.length) {
      var ch = p[i];
      if (ch === "'") {
        var end = p.indexOf("'", i + 1);
        if (end === -1) { out += p.slice(i + 1); break; }
        out += p.slice(i + 1, end);
        i = end + 1;
        continue;
      }
      if (letters.indexOf(ch) >= 0) {
        var j = i;
        while (j < p.length && p[j] === ch) j++;
        var run = p.slice(i, j);
        out += map[run] ? map[run]() : run;
        i = j;
        continue;
      }
      out += ch;
      i++;
    }
    return out;
  };

  /** 语义/语法错误：message 与 Java 侧一字不差，脚本作者看到的就该是同一句。 */
  function SpecError(message) {
    var e = new Error(message);
    e.name = "HWSpecError";
    e.hwSpec = true;
    return e;
  }
  HW.SpecError = SpecError;
  HW.util.throwSpec = function (message) { throw SpecError(message); };

  /* ---------------------------------------------------- ScriptMeta.kt 移植 */

  var STRING_KEYS = ["NAME", "DESCRIPTION", "VERSION", "AUTHOR", "UPDATED_AT", "UPDATE_URL", "MIN_ENGINE"];
  var SIZE_VALUES = ["2x2", "4x2", "4x4"];
  var SEMVER = /^\d+\.\d+\.\d+([-+].*)?$/;

  function scanRegion(source, marker, fallbackLines) {
    var cut = source.indexOf(marker);
    if (cut > 0) return source.slice(0, cut);
    return source.split(/\r?\n/).slice(0, fallbackLines).join("\n");
  }

  /** 比较两个 semver（SemVer.compare）：只比主.次.修订，带预发布后缀的更小。 */
  util.compareSemver = function (a, b) {
    function parse(v) {
      var s = String(v == null ? "" : v).trim();
      var pre = "";
      var plus = s.indexOf("+");
      if (plus >= 0) s = s.slice(0, plus);
      var dash = s.indexOf("-");
      if (dash >= 0) { pre = s.slice(dash + 1); s = s.slice(0, dash); }
      var parts = s.split(".").map(function (x) { var n = parseInt(x, 10); return isNaN(n) ? 0 : n; });
      return { n: [parts[0] || 0, parts[1] || 0, parts[2] || 0], pre: pre };
    }
    var x = parse(a), y = parse(b);
    for (var i = 0; i < 3; i++) {
      if (x.n[i] !== y.n[i]) return x.n[i] < y.n[i] ? -1 : 1;
    }
    if (x.pre && !y.pre) return -1;
    if (!x.pre && y.pre) return 1;
    if (x.pre === y.pre) return 0;
    return x.pre < y.pre ? -1 : 1;
  };

  /** ScriptMeta.parse。 */
  HW.scanMeta = function (source) {
    var region = scanRegion(source, "function render", 80);
    function str(key) {
      var m = new RegExp("const\\s+" + key + "\\s*=\\s*\"([^\"]*)\"").exec(region);
      return m ? m[1] : null;
    }
    var sizes = [];
    var sm = /const\s+SIZES\s*=\s*\[([^\]]*)\]/.exec(region);
    if (sm) {
      var re = /"([^"]*)"/g, mm;
      while ((mm = re.exec(sm[1]))) {
        if (SIZE_VALUES.indexOf(mm[1]) >= 0) sizes.push(mm[1]);
      }
    }
    var meta = {
      name: str("NAME"),
      description: str("DESCRIPTION"),
      version: str("VERSION"),
      author: str("AUTHOR"),
      sizes: sizes,
      updatedAt: str("UPDATED_AT"),
      updateUrl: str("UPDATE_URL"),
      minEngine: str("MIN_ENGINE"),
    };
    meta.declared = !!(meta.name || meta.description || meta.version || meta.author);
    meta.missingRequired = [];
    if (meta.name == null) meta.missingRequired.push("NAME");
    if (meta.description == null) meta.missingRequired.push("DESCRIPTION");
    if (meta.version == null) meta.missingRequired.push("VERSION");
    if (meta.author == null) meta.missingRequired.push("AUTHOR");
    meta.versionValid = meta.version == null || SEMVER.test(meta.version);
    meta.minEngineSatisfied = util.compareSemver(HW.ENGINE_SPEC, meta.minEngine || "0") >= 0;
    meta.displayName = function (fileName) {
      return (meta.name && meta.name.trim()) ? meta.name : fileName;
    };
    return meta;
  };

  /** ScriptMeta.withUpdatedAt —— 保存时自动维护 UPDATED_AT（与 App 保存路径同规则）。 */
  HW.withUpdatedAt = function (source, now) {
    var stamp = util.formatTime("yyyy-MM-dd HH:mm", now || new Date());
    var updatedLine = /const\s+UPDATED_AT\s*=\s*"[^"]*"/;
    var existing = updatedLine.exec(source);
    if (existing) {
      return source.slice(0, existing.index) + 'const UPDATED_AT = "' + stamp + '"' +
        source.slice(existing.index + existing[0].length);
    }
    // ⚠️ 与 Kotlin 版的唯一有意差异：这里用 `[^\S\n]*`（只吃行内空白）而不是 `\s*`。
    // `\s*` 会把 AUTHOR 行尾的换行一起匹配掉，插入点落到下一行行首，插进去的
    // `const UPDATED_AT = "…"` 就会和下一行粘连（`…"function render(){}`）——这是
    // ScriptMeta.kt 里现存的缺陷，只在不写分号的 AUTHOR 行上触发（写了 `;` 才正常）。
    // 网页工具是"保存即写盘"，不能复刻这种会把脚本改坏的行为；App 侧建议同步收紧。
    var author = /const\s+AUTHOR\s*=\s*"[^"]*"[^\S\n]*;?/.exec(source);
    if (author) {
      var at = author.index + author[0].length;
      return source.slice(0, at) + '\nconst UPDATED_AT = "' + stamp + '"' + source.slice(at);
    }
    return "// 元数据规范建议在此声明 NAME/DESCRIPTION/VERSION/AUTHOR 等\nconst UPDATED_AT = \"" + stamp + '"\n' + source;
  };

  /* -------------------------------------------------- ScriptPreset.kt 移植 */

  /**
   * ScriptPreset.parse —— 扫 `const/var/let <name> = { … };`（对象字面量）。
   * 返回 { items, strictJson }：strictJson=false 表示字面量不是严格 JSON，
   * App 侧 org.json 解析会失败（参数/全局变量不生效），工具会据此给黄条提示。
   */
  HW.scanDeclarations = function (source, constName) {
    var name = constName || "PRESETS";
    var area = scanRegion(source, "function render", 120);
    var m = new RegExp("(?:const|var|let)\\s+" + name + "\\s*=\\s*(\\{[\\s\\S]*?\\})\\s*;").exec(area);
    if (!m) return { items: [], strictJson: true };
    var json = null, strict = true;
    try {
      json = JSON.parse(m[1]);
    } catch (e) {
      strict = false;
      try {
        // 宽松兜底：注释、尾逗号、单引号在 JS 里合法但 org.json 不认——工具先渲染出来，
        // 同时把 strictJson=false 抛给 UI 提示"App 侧扫不到"。
        json = (new Function("return (" + m[1] + ");"))();
      } catch (e2) {
        return { items: [], strictJson: false };
      }
    }
    if (!json || typeof json !== "object") return { items: [], strictJson: strict };
    var items = [];
    Object.keys(json).forEach(function (key) {
      var obj = json[key];
      if (!obj || typeof obj !== "object") return;
      var type = obj.type == null ? "text" : String(obj.type).trim();
      if (!type) type = "text";
      var title = obj.title == null ? key : String(obj.title);
      if (!title.trim()) title = key;
      var def = obj["default"] == null ? "" : String(obj["default"]);
      items.push({
        key: key, title: title, type: type, default: def,
        isSwitch: type === "switch",
        defaultBool: def === "true" || def === "1" || def.toLowerCase() === "yes",
      });
    });
    return { items: items, strictJson: strict };
  };

  /* ------------------------------------------------------ RenderSpec/LayoutNode */

  /** 让校验层照抄 Java 的取值语义（LayoutNode.str/num/bool/has）。 */
  function LayoutNode(type, props) {
    this.type = type;
    this.props = props;
    this.children = [];
  }
  LayoutNode.prototype.has = function (k) { return Object.prototype.hasOwnProperty.call(this.props, k); };
  LayoutNode.prototype.str = function (k, def) {
    return this.has(k) ? String(this.props[k]) : (def === undefined ? null : def);
  };
  LayoutNode.prototype.num = function (k, def) {
    if (this.has(k)) {
      var v = this.props[k];
      if (typeof v === "number") return v;
      if (typeof v === "boolean") return v ? 1 : 0;
      var n = parseFloat(v);
      if (!isNaN(n)) return n;
    }
    return def;
  };
  LayoutNode.prototype.bool = function (k, def) {
    if (!this.has(k)) return def;
    var v = this.props[k];
    if (typeof v === "boolean") return v;
    return String(v).toLowerCase() === "true";
  };
  HW.LayoutNode = LayoutNode;

  function isPlainObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  function parseNode(o, depth, counter) {
    if (depth > HW.MAX_DEPTH) {
      throw SpecError("布局嵌套深度超过上限 " + HW.MAX_DEPTH + " 层，请拆分或扁平化");
    }
    var type = (o && (typeof o.type === "string" || typeof o.type === "number")) ? String(o.type) : null;
    if (type == null || HW.NODE_TYPES.indexOf(type) < 0) {
      throw SpecError("未知的布局节点 type: " + type + "（可用: " + HW.NODE_TYPES.join(", ") + "）");
    }
    counter.n++;
    var props = {};
    Object.keys(o).forEach(function (key) {
      if (key === "type" || key === "children") return;
      var v = o[key];
      if (v === null || v === undefined) return;
      if (isPlainObject(v)) {
        throw SpecError("布局属性 " + key + " 不支持嵌套对象");
      }
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") props[key] = v;
      else props[key] = String(v);
    });
    var node = new LayoutNode(type, props);

    var tokens = HW.COLOR_TOKENS[type];
    var colorProp = type === "box" ? "bg" : "color";
    if (tokens) {
      var c = node.str(colorProp, null);
      if (c != null && tokens.indexOf(c) < 0) {
        throw SpecError(type + " 节点的 " + colorProp + " 只能用令牌 [" + tokens.join(", ") +
          "]，收到: \"" + c + "\"（禁止写死颜色，深色模式走 values-night）");
      }
    }
    if (node.has("gravity") && HW.GRAVITY_TYPES.indexOf(type) < 0) {
      throw SpecError(type + " 节点不支持 gravity：" +
        "只有 LinearLayout 有 setGravity，GridLayout/FrameLayout 上调用会在 RemoteViews 应用时抛 ActionException。" +
        "需要居中请把子节点包一层 { type: \"column\", w: \"match\", h: \"match\", gravity: \"center\" }");
    }
    if (node.has("grow") || node.has("weight")) {
      throw SpecError(type + " 节点不支持 grow/weight：" +
        "RemoteViews 无法设置 LinearLayout 权重。需要占满行内剩余宽度请用 w: \"match\"" +
        "（只对行内最后一个节点有效，前面的节点会先按内容宽度占位）");
    }

    var ch = o.children;
    if (Array.isArray(ch)) {
      var len = ch.length;
      for (var i = 0; i < len; i++) {
        var e = ch[i];
        if (e === null || e === undefined) break;
        if (!isPlainObject(e)) {
          throw SpecError("children 里必须是节点对象，第 " + (i + 1) + " 项不是");
        }
        var child = parseNode(e, depth + 1, counter);
        if (type === "row" && i < len - 1 && child.str("w", null) === "match") {
          throw SpecError("row 的第 " + (i + 1) + " 个节点写了 w: \"match\"，" +
            "但它不是最后一个：match 会吃掉整行剩余宽度，把后面的节点挤出去。" +
            "想让「标签在左、值在右」，请把 w: \"match\" 写在行尾的那个节点上（配 align: \"end\"）");
        }
        node.children.push(child);
      }
    }
    return node;
  }

  function nodeToPlain(node) {
    return {
      type: node.type,
      props: node.props,
      children: node.children.map(nodeToPlain),
    };
  }

  function readString(o, key) {
    var v = o[key];
    if (v === null || v === undefined) return null;
    return String(v);
  }
  /** RenderSpec.readInt：Context.toNumber，NaN → null。 */
  function readInt(o, key) {
    var v = o[key];
    if (v === null || v === undefined) return null;
    var n = Number(v);
    if (isNaN(n)) return null;
    return Math.trunc(n);
  }

  /**
   * RenderSpec.from + LayoutNode.parse 的合并移植。
   * 入参 = 脚本 render() 的返回值；出参 = 可直接 postMessage 的纯数据：
   *   { mode:"tree"|"classic", root, tap, refreshSec, bleed, title, chip, big, rows, progress }
   */
  HW.parseSpec = function (o) {
    if (o === null || o === undefined || typeof o !== "object" || Array.isArray(o)) {
      throw SpecError("render() 必须返回对象");
    }
    var spec = {
      mode: "classic",
      root: null,
      title: null, chip: null, big: null,
      rows: [], progress: null,
      tap: "refresh", refreshSec: 60, bleed: false,
    };
    if (isPlainObject(o.layout)) {
      var counter = { n: 0 };
      var root = parseNode(o.layout, 1, counter);
      if (counter.n > HW.MAX_NODES) {
        throw SpecError("布局节点数超过上限 " + HW.MAX_NODES + "（当前 " + counter.n + "），请精简节点树");
      }
      spec.root = nodeToPlain(root);
      spec.mode = "tree";
      spec.nodeCount = counter.n;
    }
    spec.title = readString(o, "title");
    spec.chip = readString(o, "chip");
    spec.big = readString(o, "big");
    var tap = readString(o, "tap");
    if (tap != null && tap.trim() !== "") spec.tap = tap.trim();
    var refresh = readInt(o, "refresh");
    if (refresh != null) spec.refreshSec = Math.max(15, refresh);
    if (Array.isArray(o.rows)) {
      for (var i = 0; i < 4 && i < o.rows.length; i++) {
        var e = o.rows[i];
        if (e === null || e === undefined) break;
        if (typeof e !== "object") continue;
        var label = e[0], value = e[1];
        spec.rows.push([
          label === null || label === undefined ? "" : String(label),
          value === null || value === undefined ? "" : String(value),
        ]);
      }
    }
    if (o.bleed !== null && o.bleed !== undefined) spec.bleed = !!o.bleed;
    if (isPlainObject(o.progress)) {
      var pv = readInt(o.progress, "value"), pm = readInt(o.progress, "max");
      spec.progress = { value: pv, max: pm };
    }
    return spec;
  };

  /**
   * 把 worker 传过来的纯数据节点树还原成带 has/str/num/bool 的 LayoutNode。
   * 渲染器（render.js）用这套取值接口，跨线程只能传纯数据，所以这里补一步。
   */
  HW.hydrateSpec = function (spec) {
    if (spec && spec.root && typeof spec.root.has !== "function") {
      spec.root = (function hyd(plain) {
        var n = new LayoutNode(plain.type, plain.props || {});
        (plain.children || []).forEach(function (c) { n.children.push(hyd(c)); });
        return n;
      })(spec.root);
    }
    return spec;
  };

  /** JsBridge.sizeClass 的阈值判定。 */  HW.sizeClassOf = function (w, h) {
    if (w >= 250 && h >= 250) return "4x4";
    if (w >= 250) return "4x2";
    if (w >= 80) return "2x2";
    return "unknown";
  };

  /** 经典字段模式的行数裁剪（WidgetRenderer.maxRowsFor，桌面行为）。 */
  HW.maxRowsFor = function (minHeightDp) {
    if (minHeightDp >= 190) return 4;
    if (minHeightDp >= 120) return 3;
    return 2;
  };

  /* -------------------------------------------------- Rhino 兼容告警（V8 ≠ Rhino） */

  /**
   * 设备上是 Rhino（解释执行、ES6 子集），浏览器是 V8——**这是工具最容易"骗人"的地方**。
   * 命中即给"疑似"告警：措辞不承诺，最终判据永远是真机。
   */
  HW.RHINO_RISKS = [
    { re: /\?\./g, msg: "可选链 `?.`：Rhino 不支持，设备上会语法报错", level: "error" },
    { re: /\?\?/g, msg: "空值合并 `??`：Rhino 不支持，改用 `||` 或三元", level: "error" },
    { re: /\.replaceAll\s*\(/g, msg: "`String.replaceAll` 是 ES2021，Rhino 没有", level: "error" },
    { re: /\.flat(Map)?\s*\(/g, msg: "`Array.flat/flatMap` Rhino 没有", level: "error" },
    { re: /Object\.(fromEntries|groupBy|hasOwn)\s*\(/g, msg: "`Object.fromEntries/groupBy/hasOwn` Rhino 没有", level: "error" },
    { re: /\.at\s*\(\s*-/g, msg: "`Array.at(-1)` Rhino 没有，改用 `arr[arr.length-1]`", level: "error" },
    { re: /structuredClone\s*\(/g, msg: "`structuredClone` 没有", level: "error" },
    { re: /Intl\./g, msg: "`Intl` 在 Rhino 上不可用", level: "error" },
    { re: /\.toLocale(Date|Time|String)?\w*\s*\(/g, msg: "`toLocale*` 在 Rhino 上行为不可靠，日期格式化请手写或用 ctx.time()", level: "warn" },
    { re: /[a-zA-Z0-9_)\]]\s*\*\*\s*[a-zA-Z0-9_(]/g, msg: "`**` 幂运算符 Rhino 支持有限，改用 Math.pow", level: "warn" },
    { re: /\bglobalThis\b/g, msg: "`globalThis` Rhino 没有", level: "warn" },
    { re: /\bawait\b|\basync\s+function/g, msg: "`async/await` Rhino 不支持（脚本是同步模型）", level: "error" },
    { re: /\bfetch\s*\(/g, msg: "`fetch` 不存在，请用 ctx.http / ctx.httpBinary", level: "error" },
    { re: /\brequire\s*\(|\bimport\s+/g, msg: "Rhino 里没有模块系统", level: "error" },
    { re: /\bnew Function\s*\(|\beval\s*\(/g, msg: "`eval`/`new Function` 在 Rhino 上风险高（动态代码不在静态扫描范围内）", level: "warn" },
  ];

  /** 扫描源码里的 Rhino 风险点，返回 [{line, msg, level}]（按行去重）。 */
  HW.scanRhinoRisks = function (source) {
    var out = [];
    var seen = {};
    HW.RHINO_RISKS.forEach(function (rule) {
      var re = new RegExp(rule.re.source, "g");
      var m;
      while ((m = re.exec(source))) {
        var line = source.slice(0, m.index).split(/\r?\n/).length;
        var key = line + "|" + rule.msg;
        if (seen[key]) continue;
        seen[key] = 1;
        out.push({ line: line, msg: rule.msg, level: rule.level });
      }
    });
    return out.sort(function (a, b) { return a.line - b.line; });
  };

  /* ------------------------------------------------------------- 资源路径 */

  /** ScriptStore.resolveResource 的网页等价物：拒绝绝对路径 / .. / ://，只允许文件夹内相对路径。 */
  HW.resolveResourcePath = function (rel) {
    var p = String(rel == null ? "" : rel).trim().replace(/\\/g, "/");
    if (!p) return null;
    if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return null;
    if (p.indexOf("://") >= 0) return null;
    var parts = p.split("/");
    var stack = [];
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i];
      if (seg === "" || seg === ".") continue;
      if (seg === "..") {
        if (!stack.length) return null;
        stack.pop();
        continue;
      }
      stack.push(seg);
    }
    return stack.length ? stack.join("/") : null;
  };

  /* --------------------------------------------------------------- 导出边界 */
  if (typeof module !== "undefined" && module.exports) module.exports = HW;
})(typeof self !== "undefined" ? self : globalThis);
