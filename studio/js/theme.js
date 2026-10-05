/*
 * ============================================================================
 *  小部件设计工具 · 主题层（三态来源：直读仓库 / 主题快照 / 内置兜底）
 * ============================================================================
 *  需要这些真值：颜色令牌（浅/深）、drawable 形状、19 个图标的 pathData、内置图片、
 *  组件库 widget-ui.js。来源按优先级：
 *
 *    1. **直读仓库**（source = "app"）：探测顺序 ?repo= → 设置里保存的地址 →
 *       /app/（serve.py --app <App 仓库> 挂的）→ ../../（工具就在 App 仓库里时的老路径）。
 *       改 res/ 或组件库，刷新即见——开发时用这条。
 *    2. **主题快照**（source = "snapshot"）：js/theme.generated.js，由
 *       `node tools/sync-studio-assets.mjs --app <App 仓库>` 生成并提交。
 *       线上（GitHub Pages）读不到私有的 App 仓库，靠它保证令牌/图标/组件库与 App 一致。
 *    3. **内置兜底**（source = "fallback"）：只有 5 个颜色常量，图标会缺、没组件库——
 *       顶栏会飘红。出现它 = 快照和仓库根都没读到，别当成正常状态。
 *
 *  逐项补齐：直读模式下某个文件 404 时，用快照里的对应项补上，而不是整体降级。
 * ============================================================================
 */
(function (root) {
  "use strict";
  var HW = (root.HW = root.HW || {});

  /** 兜底令牌值（与 App 的 widget_colors.xml 一致，仅当前两级都拿不到时使用）。 */
  var FALLBACK_COLORS = {
    light: {
      widget_surface: "#F2FFFFFF",
      widget_text_primary: "#DE000000",
      widget_text_secondary: "#8A000000",
      widget_chip_bg: "#14000000",
      widget_accent: "#FF3482FF",
    },
    dark: {
      widget_surface: "#F21A1A1B",
      widget_text_primary: "#DEFFFFFF",
      widget_text_secondary: "#8AFFFFFF",
      widget_chip_bg: "#1AFFFFFF",
      widget_accent: "#FF4788FF",
    },
  };

  var FALLBACK_DRAWABLES = {
    widget_bg: { radius: 20, color: "@color/widget_surface" },
    widget_box_surface: { radius: 16, color: "@color/widget_chip_bg" },
    widget_box_card: { radius: 16, color: "@color/widget_surface" },
    widget_box_accent: { radius: 16, color: "@color/widget_accent" },
    widget_chip_bg: { radius: 10, color: "@color/widget_chip_bg" },
    widget_progress: {
      layer: true,
      background: { radius: 4, color: "@color/widget_chip_bg" },
      progress: { radius: 4, color: "@color/widget_accent" },
    },
  };

  function parseXml(text) {
    return new DOMParser().parseFromString(text, "application/xml");
  }

  /** Android #AARRGGBB → CSS rgba()。 */
  function cssColor(v) {
    if (v == null) return "transparent";
    var s = String(v).trim();
    var m = /^#([0-9a-fA-F]{8})$/.exec(s);
    if (m) {
      var a = parseInt(m[1].slice(0, 2), 16) / 255;
      var r = parseInt(m[1].slice(2, 4), 16);
      var g = parseInt(m[1].slice(4, 6), 16);
      var b = parseInt(m[1].slice(6, 8), 16);
      return "rgba(" + r + "," + g + "," + b + "," + (Math.round(a * 1000) / 1000) + ")";
    }
    m = /^#([0-9a-fA-F]{6})$/.exec(s);
    if (m) return s;
    return s;
  }

  /** `@color/widget_surface` → `var(--tok-surface)`；`@android:color/transparent` → transparent。 */
  function colorRef(v) {
    if (v == null) return null;
    var s = String(v).trim();
    var m = /^@color\/(\w+)$/.exec(s);
    if (m) return "var(--tok-" + m[1].replace(/^widget_/, "").replace(/_/g, "-") + ")";
    if (/^@android:color\/(\w+)$/.test(s)) return "transparent";
    if (/^#[0-9a-fA-F]{6,8}$/.test(s)) return cssColor(s);
    return null;
  }

  function parseShape(root) {
    var out = {};
    var corners = root.querySelector("corners");
    if (corners) out.radius = Number(corners.getAttribute("android:radius") || 0) || 0;
    var solid = root.querySelector("solid");
    if (solid) out.color = colorRef(solid.getAttribute("android:color"));
    var grad = root.querySelector("gradient");
    if (grad) {
      out.gradient = {
        start: colorRef(grad.getAttribute("android:startColor")),
        end: colorRef(grad.getAttribute("android:endColor")),
        angle: Number(grad.getAttribute("android:angle") || 0),
      };
    }
    return out;
  }

  function parseDrawable(text) {
    var doc = parseXml(text);
    var root = doc.documentElement;
    if (!root) return null;
    var tag = root.tagName;
    if (tag === "shape") return parseShape(root);
    if (tag === "layer-list") {
      var out = { layer: true };
      Array.prototype.forEach.call(root.children, function (item) {
        var id = item.getAttribute("android:id") || "";
        var shape = item.querySelector("shape");
        if (!shape) return;
        var parsed = parseShape(shape);
        if (id.indexOf("background") >= 0) out.background = parsed;
        else if (id.indexOf("progress") >= 0) out.progress = parsed;
        else out.item = parsed;
      });
      return out;
    }
    return null;
  }

  function parseVector(text) {
    var doc = parseXml(text);
    var root = doc.documentElement;
    if (!root || root.tagName !== "vector") return null;
    var vw = Number(root.getAttribute("android:viewportWidth") || 24);
    var vh = Number(root.getAttribute("android:viewportHeight") || 24);
    var paths = [];
    Array.prototype.forEach.call(root.querySelectorAll("path"), function (p) {
      var d = p.getAttribute("android:pathData");
      if (d) paths.push(d);
    });
    return { viewBox: "0 0 " + vw + " " + vh, paths: paths };
  }

  var theme = (HW.theme = {
    loaded: false,
    /** "app"（直读仓库）/ "snapshot"（主题快照）/ "fallback"（内置兜底）/ "unloaded" */
    source: "unloaded",
    problems: [],
    notes: [],
    snapshot: null,
    colors: { light: {}, dark: {} },
    drawables: {},
    icons: {},
    assets: {},          // res 名 → assets 文件名（AssetsImages.NAMES）
    assetsData: {},      // res 名 → data URL（快照里带的位图本体）
    assetBase: "",
    uiSource: "",
    cssColor: cssColor,
    colorRef: colorRef,

    /* ------------------------------------------------------------ 加载 */

    /** 候选仓库根（按序探测）。 */
    repoCandidates: function (override) {
      var out = [];
      var q = new URLSearchParams(location.search).get("repo");
      [override, q, "/app/", "../../"].forEach(function (v) {
        if (!v) return;
        var abs = new URL(v, location.href).href;
        if (abs.charAt(abs.length - 1) !== "/") abs += "/";
        if (out.indexOf(abs) < 0) out.push(abs);
      });
      return out;
    },

    /** 探测某个根是不是 App 仓库：看有没有 widget_colors.xml。 */
    probeRepo: async function (base) {
      try {
        var res = await fetch(base + "app/src/main/res/values/widget_colors.xml",
          { method: "HEAD", cache: "no-store" });
        return res.ok;
      } catch (e) {
        return false;
      }
    },

    /** 拉一个文件，失败返回 null 并记账。 */
    fetchText: async function (url) {
      try {
        var res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        return await res.text();
      } catch (e) {
        if (theme.problems.indexOf(url) < 0) theme.problems.push(url);
        return null;
      }
    },

    load: async function (repoOverride) {
      theme.problems = [];
      theme.notes = [];
      theme.colors = { light: {}, dark: {} };
      theme.drawables = {};
      theme.icons = {};
      theme.assets = {};
      theme.assetsData = {};
      theme.uiSource = "";
      theme.assetBase = "";

      // 1) 找可直读的仓库根
      var candidates = theme.repoCandidates(repoOverride);
      var base = null;
      for (var i = 0; i < candidates.length; i++) {
        if (await theme.probeRepo(candidates[i])) { base = candidates[i]; break; }
      }
      if (!base) {
        // 线上模式：App 仓库不公开、Pages 读不到 res/ → 用提交进仓库的主题快照
        if (theme.applySnapshot()) {
          theme.notes.push("主题来自快照（App@" + ((theme.snapshot.app && theme.snapshot.app.sha) || "?") + " · " +
            String(theme.snapshot.generatedAt || "").slice(0, 10) + "）：线上读不到 App 仓库，" +
            "改过 App 的 res/ 或 widget-ui.js 后要重跑 tools/sync-studio-assets.mjs 并提交");
          return theme;
        }
        theme.applyFallback();
        theme.problems.push("既没有可直读的 App 仓库，也没有主题快照（studio/js/theme.generated.js）");
        return theme;
      }

      // 2) 直读仓库
      theme.source = "app";
      theme.assetBase = base;
      var res = base + "app/src/main/res/";
      var assets = base + "app/src/main/assets/";

      var jobs = [
        theme.fetchText(res + "values/widget_colors.xml"),
        theme.fetchText(res + "values-night/widget_colors.xml"),
        theme.fetchText(assets + "widget-ui.js"),
        theme.fetchText(base + "app/src/main/java/io/github/lswlc33/hyperwidget/widget/AssetsImages.kt"),
      ];
      var drawableNames = ["widget_bg", "widget_box_surface", "widget_box_card",
        "widget_box_accent", "widget_progress", "widget_chip_bg"];
      drawableNames.forEach(function (n) { jobs.push(theme.fetchText(res + "drawable/" + n + ".xml")); });
      HW.ICON_NAMES.forEach(function (n) { jobs.push(theme.fetchText(res + "drawable/ic_w_" + n + ".xml")); });

      var got = await Promise.all(jobs);
      var k = 0;
      var lightXml = got[k++], darkXml = got[k++];
      var uiSrc = got[k++];
      var assetsKt = got[k++];

      function mergeColors(xml, mode) {
        if (!xml) return;
        var doc = parseXml(xml);
        Array.prototype.forEach.call(doc.querySelectorAll("color"), function (c) {
          var name = c.getAttribute("name");
          if (name) theme.colors[mode][name] = c.textContent.trim();
        });
      }
      mergeColors(lightXml, "light");
      mergeColors(darkXml, "dark");

      drawableNames.forEach(function (n) {
        var xml = got[k++];
        var parsed = xml ? parseDrawable(xml) : null;
        if (parsed) theme.drawables[n] = parsed;
      });
      HW.ICON_NAMES.forEach(function (n) {
        var xml = got[k++];
        var vec = xml ? parseVector(xml) : null;
        if (vec) theme.icons[n] = vec;
      });

      if (uiSrc) theme.uiSource = uiSrc;
      if (assetsKt) {
        var re = /"([A-Za-z0-9_]+)"\s+to\s+"([^"]+)"/g, m;
        while ((m = re.exec(assetsKt))) theme.assets[m[1]] = m[2];
      }

      // 3) 缺口用快照补（某项 404 不至于让整层降级），再兜底
      var filled = theme.fillFromSnapshot();
      if (filled) theme.notes.push("有 " + filled + " 项没从仓库读到，已用主题快照补齐");
      theme.fillFromFallback();
      theme.loaded = Object.keys(theme.colors.light).length > 0;
      return theme;
    },

    /* ------------------------------------------------------- 快照 / 兜底 */

    /** 整体切到快照（线上模式）。降级快照（--no-ui-source）没有 uiSource，仍算可用。 */
    applySnapshot: function () {
      var snap = HW.SNAPSHOT;
      if (!snap || !snap.colors || !snap.icons) return false;
      theme.snapshot = snap;
      theme.colors = {
        light: Object.assign({}, snap.colors.light || {}),
        dark: Object.assign({}, snap.colors.dark || {}),
      };
      theme.drawables = Object.assign({}, snap.drawables || {});
      theme.icons = Object.assign({}, snap.icons);
      theme.assets = Object.assign({}, snap.assets || {});
      theme.assetsData = Object.assign({}, snap.assetsData || {});
      theme.uiSource = snap.uiSource || "";
      theme.source = "snapshot";
      theme.loaded = true;
      theme.fillFromFallback();
      if (!theme.uiSource) {
        theme.notes.push("快照是降级版本（--no-ui-source）：没有内置组件库，脚本里的 ui.* 会报未定义，" +
          "只能手拼节点树（详见 studio/README.md「主题从哪来」）");
      }
      return true;
    },

    /** 逐项补齐（直读模式下缺什么补什么）。返回补了几项。 */
    fillFromSnapshot: function () {
      var snap = HW.SNAPSHOT;
      if (!snap) return 0;
      theme.snapshot = snap;
      var filled = 0;
      ["light", "dark"].forEach(function (mode) {
        var src = (snap.colors || {})[mode] || {};
        Object.keys(src).forEach(function (name) {
          if (!theme.colors[mode][name]) { theme.colors[mode][name] = src[name]; filled++; }
        });
      });
      Object.keys(snap.drawables || {}).forEach(function (name) {
        if (!theme.drawables[name]) { theme.drawables[name] = snap.drawables[name]; filled++; }
      });
      Object.keys(snap.icons || {}).forEach(function (n) {
        if (!theme.icons[n]) { theme.icons[n] = snap.icons[n]; filled++; }
      });
      if (!theme.uiSource && snap.uiSource) { theme.uiSource = snap.uiSource; filled++; }
      if (!Object.keys(theme.assets).length && snap.assets) { theme.assets = Object.assign({}, snap.assets); }
      if (snap.assetsData) {
        Object.keys(snap.assetsData).forEach(function (n) {
          if (!theme.assetsData[n]) theme.assetsData[n] = snap.assetsData[n];
        });
      }
      return filled;
    },

    /** 最后一级：内置常量（只有 5 个颜色 + 形状，没有图标/组件库）。 */
    fillFromFallback: function () {
      ["light", "dark"].forEach(function (mode) {
        Object.keys(FALLBACK_COLORS[mode]).forEach(function (name) {
          if (!theme.colors[mode][name]) theme.colors[mode][name] = FALLBACK_COLORS[mode][name];
        });
      });
      Object.keys(FALLBACK_DRAWABLES).forEach(function (name) {
        if (!theme.drawables[name]) theme.drawables[name] = FALLBACK_DRAWABLES[name];
      });
    },

    /** 给界面用的一句话来源说明。 */
    sourceLabel: function () {
      if (theme.source === "app") return "仓库直读（" + theme.assetBase + "）";
      if (theme.source === "snapshot") {
        var s = theme.snapshot || {};
        return "主题快照（App@" + ((s.app && s.app.sha) || "?") +
          (s.app && s.app.dirty ? "+dirty" : "") +
          " · " + String(s.generatedAt || "").slice(0, 16).replace("T", " ") +
          " · 组件库 " + (s.uiVersion || "?") + "）";
      }
      return "内置兜底（缺图标与组件库）";
    },

    /* ------------------------------------------------------------ 取值 */

    /** 令牌值（Android 原始 #AARRGGBB 或 CSS 颜色）。 */
    token: function (name, mode) {
      return theme.colors[mode || "light"][name] || null;
    },

    /** 应用主题：把令牌写成 CSS 变量挂在 :root。 */
    apply: function (mode) {
      var rootEl = document.documentElement;
      Object.keys(theme.colors.light).forEach(function (name) {
        var key = "--tok-" + name.replace(/^widget_/, "").replace(/_/g, "-");
        rootEl.style.setProperty(key, cssColor(theme.colors[mode][name]));
      });
      rootEl.setAttribute("data-hw-theme", mode);
    },

    /** 图标 SVG（fill: currentColor，令牌色由节点的 color 决定）。 */
    iconSvg: function (name) {
      var vec = theme.icons[name];
      if (!vec) return null;
      var paths = vec.paths.map(function (d) {
        return '<path d="' + d + '"/>';
      }).join("");
      return '<svg viewBox="' + vec.viewBox + '" preserveAspectRatio="xMidYMid meet" ' +
        'style="width:100%;height:100%;display:block" fill="currentColor">' + paths + "</svg>";
    },

    /** 内置图片（res 白名单）的 URL：直读模式给仓库地址，其余给快照里的 data URL。 */
    assetUrl: function (resName) {
      var file = theme.assets[resName];
      if (!file) return null;
      if (theme.source === "app" && theme.assetBase) {
        return theme.assetBase + "app/src/main/assets/" + file;
      }
      if (theme.assetsData && theme.assetsData[resName]) return theme.assetsData[resName];
      if (theme.assetBase) return theme.assetBase + "app/src/main/assets/" + file;
      return null;
    },
  });
})(typeof self !== "undefined" ? self : globalThis);
