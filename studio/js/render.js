/*
 * ============================================================================
 *  小部件设计工具 · 渲染层（spec → DOM）
 * ============================================================================
 *  逐条对照 WidgetRenderer.kt + prim_*.xml + widget_root*.xml + custom_widget.xml：
 *    - 布局树模式：节点 → 原语 div，属性语义与 applyProps 一致（match/wrap、gap spacer、
 *      parentIsRow 的 wrap_content 特判、gravity 映射、box 令牌→drawable 色/圆角…）
 *    - 经典字段模式：复刻 custom_widget.xml 的字号/间距/行数阈值
 *    - 大图：file / url&uri 走 canvas 复刻 WidgetImageService.compose（裁切+面板+渐变+圆角）
 *
 *  坐标：画布 1dp = 1px（CSS），图片按 density 备份像素保证清晰。
 *  字体：Android 含 font padding 的行高约 1.32em；字宽/字距与 Roboto 仍有残差，
 *  见 docs/网页设计工具计划.md §3.1「不模拟」清单——**像素级结论以真机为准**。
 * ============================================================================
 */
(function (root) {
  "use strict";
  var HW = (root.HW = root.HW || {});
  var theme = HW.theme;

  var CONTAINER_TYPES = { column: 1, row: 1, stack: 1, box: 1, grid: 1 };
  var TOKEN_VAR = {
    primary: "var(--tok-text-primary)",
    secondary: "var(--tok-text-secondary)",
    accent: "var(--tok-accent)",
  };
  var BOX_BG = {
    surface: { color: "var(--tok-chip-bg)", radius: 16 },
    card: { color: "var(--tok-surface)", radius: 16 },
    accent: { color: "var(--tok-accent)", radius: 16 },
    none: { color: "transparent", radius: 0 },
  };

  /** Chronometer 的显示格式（DateUtils.formatElapsedTime 同款）。 */
  function formatElapsed(sec, countdown) {
    var neg = sec < 0;
    var s = Math.floor(Math.abs(sec));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    function p(n) { return String(n).padStart(2, "0"); }
    return (neg ? "-" : "") + (h > 0 ? h + ":" + p(m) : p(m)) + ":" + p(ss);
  }

  /* --------------------------------------------------------------- 静态诊断 */

  /** 真机踩过的坑在这里提前说：能改的改，改不了的（宿主行为）明确标注。 */
  function lintTree(root) {
    var out = [];
    var LEAF = { text: 1, icon: 1, image: 1, clock: 1, chrono: 1 };

    /**
     * 宽度是否"确定"——决定 w:"match" 在 FrameLayout 里能不能解出尺寸（陷阱 4 的精确版）。
     * 模板 layout_width=match_parent 的节点在父宽度确定时同样确定；
     * 行内未写 w 的子容器被渲染器改成 wrap_content，于是不确定。
     */
    function definiteWidth(node, parentKind, parentDefinite) {
      if (parentKind === "content") return true;            // widget_content 就是固定画布
      if (node.has("w")) {
        var w = String(node.str("w", ""));
        if (w === "wrap") return false;
        if (w === "match") return parentDefinite;
        return !isNaN(parseFloat(w));
      }
      if (LEAF[node.type]) return false;
      if (parentKind === "row") return false;
      return parentDefinite;
    }

    (function walk(node, parentKind, parentDefinite) {
      var t = node.type, p = node.props || {};
      if (p.gravity !== undefined && t !== "column" && t !== "row") {
        out.push({ level: "error", msg: t + " 节点不支持 gravity（真机会在 apply 时抛 ActionException）" });
      }
      if (t === "box" || t === "stack") {
        var kids = node.children || [];
        // 叠放（底 + 字）是 stack/box 的正当用法，前提是**每个子项都写死 w/h**（手册 §5 ui.stack）；
        // 有多子项又没都定尺寸，才是"以为它会纵向排列"的误用。
        var allSized = kids.length > 0 && kids.every(function (c) {
          return c.has("w") && c.has("h");
        });
        if (kids.length > 1 && !allSized) {
          out.push({
            level: "warn",
            msg: t + " 是 FrameLayout 语义：多个子项会**叠**在左上角（不是纵向排列）。" +
              "要上下排内容请包一层 column（注意 ui.card 也是 box）；" +
              "确实要叠放（底 + 字）时，给每个子项都写死 w/h",
          });
        }
        if (t === "box" && !p.w && !(node.children || []).length && (parentKind === "row" || parentKind === "stack")) {
          out.push({ level: "warn", msg: "空 box 没写 w：在 row/stack 里会塌成 0 宽而完全看不见（陷阱 5）" });
        }
      }
      if (t === "image" && !p.file && !p.path && !p.res && !p.b64 && !p.url) {
        out.push({ level: "error", msg: "image 节点没有来源（path/url/res/b64 需要其一）" });
      }

      var selfDefinite = definiteWidth(node, parentKind, parentDefinite);
      (node.children || []).forEach(function (c) {
        var cp = c.props || {};
        if ((t === "box" || t === "stack") && !selfDefinite &&
            (cp.w === "match" || cp.h === "match")) {
          out.push({
            level: "warn",
            msg: t + " 自身尺寸不确定（没写固定 w/h）时，里面 w/h:\"match\" 的子项解不出尺寸、" +
              "真机会退回 wrap_content（陷阱 4）。给这个 " + t + " 写死 w/h，或让它父容器给出确定宽度",
          });
        }
        walk(c, t, selfDefinite);
      });
    })(root, "content", true);
    return out;
  }

  /* ------------------------------------------------------------- 节点 → DOM */

  function el(tag, cls) {
    var e = document.createElement(tag || "div");
    if (cls) e.className = cls;
    return e;
  }

  function applyPadding(node, e) {
    if (node.has("padding")) {
      var p = node.num("padding", 0);
      e.style.padding = p + "px";
      e.dataset.pad = String(p);
    }
  }

  function applyGravity(node, e) {
    if (!node.has("gravity")) return;
    var parts = String(node.str("gravity", "")).trim().split(/\s+/);
    var main = null, cross = null;
    var isRow = node.type === "row";
    parts.forEach(function (p) {
      if (p === "left" || p === "start") { isRow ? main = "flex-start" : cross = "flex-start"; }
      else if (p === "right" || p === "end") { isRow ? main = "flex-end" : cross = "flex-end"; }
      else if (p === "center_horizontal") { isRow ? main = "center" : cross = "center"; }
      else if (p === "top") { isRow ? cross = "flex-start" : main = "flex-start"; }
      else if (p === "bottom") { isRow ? cross = "flex-end" : main = "flex-end"; }
      else if (p === "center_vertical") { isRow ? cross = "center" : main = "center"; }
      else if (p === "center") { main = "center"; cross = "center"; }
    });
    e.style.justifyContent = main || "flex-start";
    e.style.alignItems = cross || "flex-start";
  }

  /**
   * 宽高：对齐 applyProps/setDimension 的三种取值 + 模板默认值。
   * 返回告警（真机与 CSS 有已知差异时提示）。
   */
  function applySize(node, e, parentKind) {
    var notes = [];
    var isContainer = !!CONTAINER_TYPES[node.type];
    var inRow = parentKind === "row";
    var inStackLike = parentKind === "stack" || parentKind === "box";

    function setWidth(v) { e.style.width = v; }
    if (node.has("w")) {
      var w = String(node.str("w", ""));
      if (w === "match") {
        if (inStackLike) {
          // 陷阱 4 的精确版：match 在 FrameLayout 里**能**生效，前提是 FrameLayout 自己有确定尺寸
          // （内建「系统状态」磁贴就是 box 里塞 w:"match" 的 column）。父容器宽高不确定时才退回 wrap，
          // 这一点交给 CSS 自己算（auto 尺寸格子里百分比会退化成内容宽度），lint 会另外提醒。
          e.style.width = "auto";
          e.style.justifySelf = "stretch";
        } else if (inRow) {
          e.style.flex = "1 1 0";
          e.style.minWidth = "0";
        } else {
          setWidth("100%");
        }
      } else if (w === "wrap") {
        e.style.width = "auto";
        e.style.alignSelf = "flex-start";
      } else if (!isNaN(parseFloat(w))) {
        setWidth(parseFloat(w) + "px");
        e.style.flex = "0 0 auto";
      }
    } else if (isContainer) {
      // 模板 layout_width=match_parent；行内子容器渲染器特判成 wrap_content（否则独占整行）
      if (inRow) { e.style.width = "auto"; e.style.flex = "0 1 auto"; }
      else setWidth("100%");
    } else {
      e.style.width = "auto";
      if (!inRow) e.style.alignSelf = "flex-start";
    }

    if (node.has("h")) {
      var h = String(node.str("h", ""));
      if (h === "match") {
        if (inStackLike) {
          e.style.height = "auto";
          e.style.alignSelf = "stretch";
        } else if (inRow) {
          e.style.height = "100%";
        } else {
          e.style.flex = "1 1 0";
          e.style.minHeight = "0";
        }
      } else if (h === "wrap") {
        e.style.height = "auto";
      } else if (!isNaN(parseFloat(h))) {
        e.style.height = parseFloat(h) + "px";
      }
    }
    return notes;
  }

  function applyTextLike(node, e, defaultSize) {
    var size = node.has("size") ? node.num("size", defaultSize) : defaultSize;
    e.style.fontSize = size + "px";
    e.style.lineHeight = "1.32";
    e.style.color = TOKEN_VAR[node.str("color", "primary")] || TOKEN_VAR.primary;
    if (node.bool("bold", false)) e.style.fontWeight = "700";
    var maxLines = node.has("maxLines") ? Math.max(1, Math.trunc(node.num("maxLines", 1))) : 1;
    if (maxLines === 1) {
      e.style.whiteSpace = "nowrap";
      e.style.overflow = "hidden";
      e.style.textOverflow = "ellipsis";
    } else {
      e.style.display = "-webkit-box";
      e.style.webkitBoxOrient = "vertical";
      e.style.webkitLineClamp = String(maxLines);
      e.style.overflow = "hidden";
      e.style.whiteSpace = "normal";
    }
    var align = node.str("align", "start");
    e.style.textAlign = align === "center" ? "center" : (align === "end" || align === "right") ? "right" : "left";
  }

  /* ------------------------------------------------------- 图片合成（大图） */

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error("图片解码失败（仅支持 PNG/JPEG/WebP）")); };
      img.src = src;
    });
  }

  /** WidgetImageService.cropTo 的移植（源图更宽左右居中裁，更高从顶部裁）。 */
  function cropRect(sw, sh, targetAspect) {
    var srcAspect = sw / sh;
    if (srcAspect > targetAspect) {
      var w = Math.min(sw, Math.max(1, Math.round(sh * targetAspect)));
      return { x: Math.round((sw - w) / 2), y: 0, w: w, h: sh };
    }
    var h = Math.min(sh, Math.max(1, Math.round(sw / targetAspect)));
    return { x: 0, y: 0, w: sw, h: h };
  }

  /**
   * 复刻 WidgetImageService.compose：画稿裁切 → 底部面板 → 渐变过渡 → 圆角。
   * 参数全是 dp；density 只影响备份像素（清晰度），不影响版式。
   *
   * ⚠️ 圆角那段照抄 Kotlin 的**并集**填充：`round` 处先画「底部两角圆」的矩形，
   * 再 addRect 把 panelBottom..outH 的溢出区补成方角——两段并集后，可见底边其实是方的
   * （圆角被溢出区盖住）。工具按设备真实结果渲染，而不是按注释里的意图美化。
   */
  function composeToCanvas(img, node, density) {
    var d = density || 3;
    var wDp = node.num("w", 0), hDp = node.num("h", 0);
    var outW = Math.max(1, Math.round((wDp > 0 ? wDp : img.naturalWidth / d) * d));
    var outH = Math.max(1, Math.round((hDp > 0 ? hDp : img.naturalHeight / d) * d));
    var panelTop = Math.min(outH, Math.round(node.num("paneltop", 0) * d));
    var artH = Math.max(1, panelTop);
    var fadePx = Math.round(node.num("fade", 0) * d);
    var roundPx = Math.round(node.num("round", 0) * d);
    var insetPx = Math.round(node.num("panelinset", 0) * d);
    var cornerPx = Math.round(node.num("corner", 0) * d);
    var mode = node.str("mode", "crop");

    var cv = document.createElement("canvas");
    cv.width = outW;
    cv.height = outH;
    var g = cv.getContext("2d");
    g.imageSmoothingQuality = "high";

    // 1) 画稿：crop 按「宽 × paneltop」比例裁（源图更高从顶部裁），再缩放到该尺寸
    if (mode === "stretch") {
      g.drawImage(img, 0, 0, outW, artH);
    } else {
      var r = cropRect(img.naturalWidth, img.naturalHeight, outW / artH);
      g.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, outW, artH);
    }

    // 2) 渐变要在面板之下，3) 面板浮层叠在上面（顺序不能反：浮层半透明）
    if (panelTop < outH) {
      var panelColor = cssToken("--tok-chip-bg");   // WidgetPreviewProvider: panelColor = widget_chip_bg
      var fadeColor = cssToken("--tok-surface");    // fadeColor = widget_surface
      if (fadePx > 0) {
        var fade = Math.min(fadePx, artH);
        var grad = g.createLinearGradient(0, panelTop - fade, 0, panelTop);
        grad.addColorStop(0, rgbaOf(fadeColor, 0));
        grad.addColorStop(1, fadeColor);
        g.fillStyle = grad;
        g.fillRect(0, panelTop - fade, outW, fade);
      }
      var panelBottom = roundPx > 0 ? Math.min(outH, Math.max(panelTop, roundPx)) : outH;
      g.fillStyle = panelColor;
      g.beginPath();
      if (insetPx > 0) {
        // 内缩的圆角浮层：四角都圆（官方那块就是这种，不是通铺到边）
        pathRoundRect(g, insetPx, panelTop, outW - insetPx * 2, panelBottom - panelTop, cornerPx, cornerPx, cornerPx, cornerPx);
      } else if (cornerPx > 0 && roundPx > 0) {
        pathRoundRect(g, 0, panelTop, outW, panelBottom + cornerPx - panelTop, 0, 0, cornerPx, cornerPx);
        g.rect(0, panelBottom, outW, outH - panelBottom);
      } else {
        g.rect(0, panelTop, outW, outH - panelTop);
      }
      g.fill();
    }
    return cv;
  }

  /** 每角半径可分别指定的圆角矩形路径（对齐 Path.addRoundRect 的 float[] radii）。 */
  function pathRoundRect(g, x, y, w, h, tl, tr, br, bl) {
    var max = Math.min(w / 2, h / 2);
    tl = Math.max(0, Math.min(tl, max)); tr = Math.max(0, Math.min(tr, max));
    br = Math.max(0, Math.min(br, max)); bl = Math.max(0, Math.min(bl, max));
    g.moveTo(x + tl, y);
    g.lineTo(x + w - tr, y);
    if (tr) g.arcTo(x + w, y, x + w, y + tr, tr); else g.lineTo(x + w, y);
    g.lineTo(x + w, y + h - br);
    if (br) g.arcTo(x + w, y + h, x + w - br, y + h, br); else g.lineTo(x + w, y + h);
    g.lineTo(x + bl, y + h);
    if (bl) g.arcTo(x, y + h, x, y + h - bl, bl); else g.lineTo(x, y + h);
    g.lineTo(x, y + tl);
    if (tl) g.arcTo(x, y, x + tl, y, tl); else g.lineTo(x, y);
    g.closePath();
  }

  function cssToken(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
  }
  function rgbaOf(color, a) {
    var probe = document.createElement("div");
    probe.style.color = color;
    document.body.appendChild(probe);
    var comp = getComputedStyle(probe).color;
    probe.remove();
    var m = /rgba?\(([^)]+)\)/.exec(comp);
    if (!m) return color;
    var p = m[1].split(",").map(function (x) { return x.trim(); });
    return "rgba(" + p[0] + "," + p[1] + "," + p[2] + "," + a + ")";
  }

  /* ------------------------------------------------------------- 构建入口 */

  async function render(container, spec, opts) {
    opts = opts || {};
    spec = HW.hydrateSpec(spec);          // worker 传来的是纯数据，补回 LayoutNode 的取值接口
    var resMap = opts.resMap || {};
    var density = opts.density || 3;
    var objectUrls = [];
    var disposers = [];
    var notes = [];

    container.innerHTML = "";
    var canvasW = opts.canvas.w, canvasH = opts.canvas.h;
    var canvas = el("div", "wcanvas");
    canvas.style.width = canvasW + "px";
    canvas.style.height = canvasH + "px";
    canvas.style.padding = spec.bleed ? "0px" : "15px";
    if (spec.bleed) canvas.classList.add("bleed");
    if (opts.onTap) {
      canvas.addEventListener("click", function (ev) {
        var hit = ev.target.closest("[data-tap]");
        if (hit) {
          ev.stopPropagation();
          opts.onTap(hit.dataset.tap, hit.dataset.tapSource || "node");
        }
      });
    }
    container.appendChild(canvas);

    var content = el("div", "wcontent");
    canvas.appendChild(content);

    var ctxState = {
      resMap: resMap, density: density, objectUrls: objectUrls,
      scriptName: opts.scriptName || "", notes: notes, spec: spec,
    };

    if (spec.mode === "tree" && spec.root) {
      var rootEl = await buildNode(spec.root, "content", ctxState);
      rootEl.classList.add("wroot");
      if (spec.tap && spec.tap !== "none") {
        rootEl.dataset.tap = spec.tap;
        rootEl.dataset.tapSource = "card";
      }
      content.appendChild(rootEl);
      notes = notes.concat(lintTree(spec.root, opts.canvas));
    } else {
      buildClassic(content, spec, opts, ctxState);
    }

    // clock / chrono 每秒走字（设备上是 TextClock/Chronometer 自己走）
    var tickers = ctxState.tickers || [];
    if (tickers.length) {
      var update = function () {
        tickers.forEach(function (t) {
          try { t.update(new Date()); } catch (e) { /* 走字失败不影响其它 */ }
        });
      };
      update();
      var timer = setInterval(update, 1000);
      disposers.push(function () { clearInterval(timer); });
    }
    disposers.push(function () {
      objectUrls.forEach(function (u) { URL.revokeObjectURL(u); });
    });

    return {
      canvas: canvas,
      notes: notes,
      classicNote: ctxState.classicNote || null,
      dispose: function () { disposers.forEach(function (f) { f(); }); },
    };
  }

  /* ------------------------------------------------------------ 布局树节点 */

  async function buildNode(node, parentKind, st) {
    var t = node.type;
    var e = el("div", "nd nd-" + t);
    e.dataset.type = t;
    var parentIsRow = parentKind === "row";

    applyPadding(node, e);
    var sizeNotes = applySize(node, e, parentKind);
    sizeNotes.forEach(function (n) { st.notes.push({ level: "warn", msg: n }); });

    if (node.str("tap", null) != null) {
      e.dataset.tap = String(node.str("tap", ""));
      e.style.cursor = "pointer";
    }

    switch (t) {
      case "column":
      case "row":
        e.style.display = "flex";
        e.style.flexDirection = t === "row" ? "row" : "column";
        e.style.justifyContent = "flex-start";
        e.style.alignItems = "flex-start";
        applyGravity(node, e);
        e.style.boxSizing = "border-box";
        break;
      case "stack":
      case "box":
        // FrameLayout 语义：子项都在同一格、左上角对齐、可互相覆盖。
        // 用 grid 的「同一格叠放」而不是 position:absolute —— 后者会让子项脱离文档流，
        // box 的高度就塌成 0（真机上 FrameLayout 的 wrap_content 是会被子项撑开的）。
        e.style.display = "grid";
        e.style.gridTemplateColumns = "100%";
        e.style.gridTemplateRows = "auto";
        e.style.alignItems = "start";
        e.style.justifyItems = "start";
        if (t === "box") {
          var bg = BOX_BG[node.str("bg", "surface")] || BOX_BG.surface;
          e.style.background = bg.color;
          var radius = node.has("radius") ? node.num("radius", 16) : bg.radius;
          e.style.borderRadius = radius + "px";
          if (!node.has("h") && !node.has("w") && !(node.children || []).length) {
            e.classList.add("nd-collapsed");
          }
        }
        break;
      case "grid":
        e.style.display = "grid";
        var cols = Math.min(12, Math.max(1, Math.trunc(node.num("cols", 2))));
        e.style.gridTemplateColumns = "repeat(" + cols + ", auto)";
        e.style.gridAutoRows = "min-content";
        e.style.justifyContent = "start";
        e.style.alignContent = "start";
        e.style.boxSizing = "border-box";
        break;
      case "spacer":
        e.style.flex = "0 0 auto";
        break;
      case "text":
        applyTextLike(node, e, 14);
        e.style.display = "block";
        e.textContent = node.str("text", "");
        break;
      case "clock":
        applyTextLike(node, e, 16);
        var fmt = node.str("format", "HH:mm");
        e.textContent = HW.util.formatTime(fmt, new Date());
        (st.tickers = st.tickers || []).push({
          el: e, update: function (now) { e.textContent = HW.util.formatTime(fmt, now); },
        });
        break;
      case "chrono":
        applyTextLike(node, e, 14);
        var baseMs = node.has("base") ? node.num("base", 0) : performance.now();
        var running = node.bool("running", true);
        var countdown = node.bool("countdown", false);
        var frozen = 0;
        var applyChrono = function () {
          var sec = (running ? performance.now() : frozen) - baseMs;
          sec = sec / 1000;
          e.textContent = formatElapsed(countdown ? -sec : sec);
        };
        (st.tickers = st.tickers || []).push({
          el: e, update: function () { if (running) applyChrono(); },
        });
        applyChrono();
        break;
      case "icon":
        var name = String(node.str("name", "")).trim().toLowerCase();
        var svg = theme.iconSvg(name);
        if (!svg) {
          throw HW.SpecError("未知图标: \"" + name + "\"（可用: " + HW.ICON_NAMES.join(", ") + "）");
        }
        var iconSize = node.num("size", 24);
        e.style.width = iconSize + "px";
        e.style.height = iconSize + "px";
        e.style.color = TOKEN_VAR[node.str("color", "primary")] || TOKEN_VAR.primary;
        e.innerHTML = svg;
        e.classList.add("nd-iconbox");
        break;
      case "image":
        await buildImage(node, e, st);
        break;
      case "progress":
        var max = Math.max(1, Math.trunc(node.num("max", 100)));
        var value = Math.min(max, Math.max(0, Math.trunc(node.num("value", 0))));
        e.style.boxSizing = "border-box";
        if (!node.has("h")) e.style.height = "8px";
        e.style.background = "var(--tok-chip-bg)";
        e.style.borderRadius = "4px";
        e.style.overflow = "hidden";
        var fill = el("div", "nd-progress-fill");
        fill.style.height = "100%";
        fill.style.width = (value / max * 100) + "%";
        fill.style.background = "var(--tok-accent)";
        fill.style.borderRadius = value >= max ? "4px" : "4px 0 0 4px";
        e.appendChild(fill);
        e.dataset.value = value + "/" + max;
        break;
      default:
        break;
    }

    var children = node.children || [];
    var gap = node.num("gap", 0);
    for (var i = 0; i < children.length; i++) {
      if (gap > 0 && i > 0 && (t === "row" || t === "column")) {
        var sp = el("div", "nd-gap");
        sp.style.flex = "0 0 auto";
        if (t === "row") sp.style.width = gap + "px";
        else sp.style.height = gap + "px";
        e.appendChild(sp);
      }
      var childEl = await buildNode(children[i], t, st);
      if (t === "stack" || t === "box") {
        // 所有子项放进同一格（叠放），padding 由容器的 grid padding 自动生效
        childEl.style.gridArea = "1 / 1";
        // 宽度：容器与 progress 的模板是 match_parent（撑满整格），text/icon/image 是 wrap_content
        var cw = children[i].has("w") ? String(children[i].str("w", "")) : null;
        if (cw === null && (CONTAINER_TYPES[children[i].type] || children[i].type === "progress")) {
          childEl.style.justifySelf = "stretch";
        }
      }
      e.appendChild(childEl);
    }
    return e;
  }

  /** image 节点：来源优先级 file > path > res(白名单→assets，未命中按相对路径) > b64。 */
  async function buildImage(node, e, st) {
    var file = String(node.str("file", "") || "").trim();
    var path = String(node.str("path", "") || "").trim();
    var res = String(node.str("res", "") || "").trim();
    var b64 = String(node.str("b64", "") || "").trim();
    var wDp = node.num("w", 0), hDp = node.num("h", 0);
    var density = st.density;

    function setBox(cssW, cssH) {
      if (wDp > 0) e.style.width = wDp + "px";
      else if (cssW) e.style.width = cssW + "px";
      if (hDp > 0) e.style.height = hDp + "px";
      else if (cssH) e.style.height = cssH + "px";
      e.style.flex = "0 0 auto";
      e.style.display = "block";
    }

    function blobUrlFor(rel) {
      var bytes = st.resMap[rel];
      if (!bytes) return null;
      var blob = new Blob([bytes]);
      var url = URL.createObjectURL(blob);
      st.objectUrls.push(url);
      return url;
    }

    function missing(rel) {
      throw HW.SpecError("资源不存在: \"" + rel + "\"（网页里读的是脚本资源文件夹；" +
        "该文件夹随脚本一起打开，缓存的在线图在 cache/ 下）");
    }

    // 1) file（大图：走合成；真机上经 content:// 交给宿主解码）
    if (file) {
      var url = blobUrlFor(file);
      if (!url) {
        if (file.startsWith("cache/")) {
          throw HW.SpecError("资源不存在: \"" + file + "\"（这是缓存文件，真机上下载过才有；" +
            "在数据面板里开网络跑一次即可生成，或把真机的 cache/ 一起拷过来）");
        }
        missing(file);
      }
      var img = await loadImage(url);
      var cv = composeToCanvas(img, node, density);
      setBox(Math.round(cv.width / density), Math.round(cv.height / density));
      e.appendChild(cv);
      return;
    }

    // 2) path / res 相对路径兜底
    var rel = null;
    if (path) rel = path;
    else if (res && !theme.assetUrl(res)) rel = res;

    if (rel) {
      var rel2 = HW.resolveResourcePath(rel);
      if (!rel2) {
        throw HW.SpecError("资源路径不可用: \"" + rel + "\"（内置资源名可用: " +
          Object.keys(theme.assets).join(", ") + "；相对路径基于脚本资源文件夹，不能跳出）");
      }
      var u2 = blobUrlFor(rel2);
      if (!u2) missing(rel2);
      var im2 = await loadImage(u2);
      var iw = im2.naturalWidth, ih = im2.naturalHeight;
      var imgEl = el("img", "nd-img");
      imgEl.src = u2;
      imgEl.style.objectFit = "contain";
      imgEl.style.display = "block";
      setBox(wDp > 0 ? wDp : Math.round(iw / density), hDp > 0 ? hDp : Math.round(ih / density));
      e.appendChild(imgEl);
      return;
    }

    // 3) res 内置白名单（assets）
    if (res) {
      var aurl = theme.assetUrl(res);
      if (!aurl) {
        throw HW.SpecError("内置图片解码失败: " + res + "（白名单: " + Object.keys(theme.assets).join(", ") + "）");
      }
      var u3 = opts_asset(aurl);
      var im3 = await loadImage(u3);
      var imgEl3 = el("img", "nd-img");
      imgEl3.src = u3;
      imgEl3.style.objectFit = "contain";
      imgEl3.style.display = "block";
      setBox(Math.round(im3.naturalWidth / density), Math.round(im3.naturalHeight / density));
      e.appendChild(imgEl3);
      return;
    }

    // 4) b64
    if (b64) {
      var data = b64.indexOf("base64,") >= 0 ? b64.slice(b64.indexOf("base64,") + 7) : b64;
      var src = "data:image/*;base64," + data.replace(/\s/g, "");
      var im4;
      try {
        im4 = await loadImage(src);
      } catch (err) {
        throw HW.SpecError("图片 base64 解码失败");
      }
      var imgEl4 = el("img", "nd-img");
      imgEl4.src = src;
      imgEl4.style.objectFit = "contain";
      imgEl4.style.display = "block";
      setBox(Math.round(im4.naturalWidth / density), Math.round(im4.naturalHeight / density));
      e.appendChild(imgEl4);
      return;
    }

    throw HW.SpecError("image 节点需要 path / url / res / b64 之一（见开发手册第 5 章）");
  }
  function opts_asset(u) { return u; }

  /* ------------------------------------------------------- 经典字段模式 */

  function buildClassic(content, spec, opts, st) {
    var root = el("div", "cw-root");
    root.style.display = "flex";
    root.style.flexDirection = "column";
    root.style.alignItems = "flex-start";
    root.style.width = "100%";
    root.style.height = "100%";
    root.style.boxSizing = "border-box";

    var head = el("div", "cw-head");
    head.style.display = "flex";
    head.style.flexDirection = "row";
    head.style.alignItems = "center";
    head.style.width = "100%";
    var title = el("div", "cw-title");
    title.textContent = spec.title == null ? (opts.scriptName || "") : spec.title;
    title.style.fontSize = "14px";
    title.style.fontWeight = "700";
    title.style.lineHeight = "1.32";
    title.style.color = "var(--tok-text-primary)";
    title.style.flex = "1 1 0";
    title.style.minWidth = "0";
    title.style.whiteSpace = "nowrap";
    title.style.overflow = "hidden";
    title.style.textOverflow = "ellipsis";
    head.appendChild(title);
    if (spec.chip) {
      var chip = el("div", "cw-chip");
      chip.textContent = spec.chip;
      chip.style.padding = "2px 8px";
      chip.style.background = "var(--tok-chip-bg)";
      chip.style.borderRadius = "10px";
      chip.style.fontSize = "12px";
      chip.style.lineHeight = "1.32";
      chip.style.color = "var(--tok-text-primary)";
      chip.style.whiteSpace = "nowrap";
      chip.style.flex = "0 0 auto";
      head.appendChild(chip);
    }
    root.appendChild(head);

    if (spec.big) {
      var big = el("div", "cw-big");
      big.textContent = spec.big;
      big.style.marginTop = "4px";
      big.style.fontSize = "26px";
      big.style.fontWeight = "700";
      big.style.lineHeight = "1.32";
      big.style.color = "var(--tok-text-primary)";
      big.style.whiteSpace = "nowrap";
      big.style.overflow = "hidden";
      big.style.textOverflow = "ellipsis";
      big.style.maxWidth = "100%";
      big.style.alignSelf = "stretch";
      root.appendChild(big);
    }

    if (spec.progress && spec.progress.value != null && spec.progress.max != null && spec.progress.max > 0) {
      var max = spec.progress.max;
      var value = Math.min(max, Math.max(0, spec.progress.value));
      var bar = el("div", "cw-progress");
      bar.style.marginTop = "6px";
      bar.style.width = "100%";
      bar.style.height = "8px";
      bar.style.background = "var(--tok-chip-bg)";
      bar.style.borderRadius = "4px";
      bar.style.overflow = "hidden";
      bar.style.alignSelf = "stretch";
      var fill = el("div");
      fill.style.height = "100%";
      fill.style.width = (value / max * 100) + "%";
      fill.style.background = "var(--tok-accent)";
      fill.style.borderRadius = value >= max ? "4px" : "4px 0 0 4px";
      bar.appendChild(fill);
      root.appendChild(bar);
    }

    var maxRows = HW.maxRowsFor(opts.canvas.h);
    st.classicNote = "rows 上限 " + maxRows + " 行（桌面按高度 " + opts.canvas.h + "dp → " +
      (opts.canvas.h >= 190 ? "4" : opts.canvas.h >= 120 ? "3" : "2") + " 行裁剪，多的行桌面上看不见）";
    spec.rows.forEach(function (row, i) {
      if (i >= maxRows) return;
      var r = el("div", "cw-row");
      r.style.display = "flex";
      r.style.flexDirection = "row";
      r.style.alignItems = "center";
      r.style.width = "100%";
      r.style.marginTop = i === 0 ? "6px" : "2px";
      r.style.alignSelf = "stretch";
      var label = el("div");
      label.textContent = row[0];
      label.style.flex = "1 1 0";
      label.style.minWidth = "0";
      label.style.fontSize = "12px";
      label.style.lineHeight = "1.32";
      label.style.color = "var(--tok-text-secondary)";
      label.style.whiteSpace = "nowrap";
      label.style.overflow = "hidden";
      label.style.textOverflow = "ellipsis";
      var value = el("div");
      value.textContent = row[1];
      value.style.fontSize = "12px";
      value.style.lineHeight = "1.32";
      value.style.color = "var(--tok-text-primary)";
      value.style.whiteSpace = "nowrap";
      value.style.marginLeft = "8px";
      r.appendChild(label);
      r.appendChild(value);
      root.appendChild(r);
    });

    if (spec.tap && spec.tap !== "none") {
      root.dataset.tap = spec.tap;
    }
    content.appendChild(root);
  }

  /** 脚本出错时的错误卡片（复刻 WidgetRenderer.renderError）。 */
  function renderError(container, info) {
    container.innerHTML = "";
    var canvas = el("div", "wcanvas");
    canvas.style.width = info.canvas.w + "px";
    canvas.style.height = info.canvas.h + "px";
    canvas.style.padding = "15px";
    container.appendChild(canvas);

    var root = el("div", "cw-root");
    root.style.display = "flex";
    root.style.flexDirection = "column";
    root.style.width = "100%";
    root.style.height = "100%";
    root.style.boxSizing = "border-box";

    var head = el("div");
    head.style.display = "flex";
    head.style.alignItems = "center";
    head.style.width = "100%";
    var title = el("div");
    title.textContent = info.title || info.scriptName || "";
    title.style.fontSize = "14px";
    title.style.fontWeight = "700";
    title.style.color = "var(--tok-text-primary)";
    title.style.flex = "1 1 0";
    title.style.minWidth = "0";
    title.style.whiteSpace = "nowrap";
    title.style.overflow = "hidden";
    title.style.textOverflow = "ellipsis";
    var chip = el("div");
    chip.textContent = "脚本错误";
    chip.style.padding = "2px 8px";
    chip.style.background = "var(--tok-chip-bg)";
    chip.style.borderRadius = "10px";
    chip.style.fontSize = "12px";
    chip.style.color = "var(--tok-text-primary)";
    head.appendChild(title);
    head.appendChild(chip);
    root.appendChild(head);

    var msg = el("div");
    msg.textContent = (info.scriptName ? info.scriptName + ": " : "") + info.message;
    msg.style.marginTop = "6px";
    msg.style.fontSize = "11px";
    msg.style.lineHeight = "1.32";
    msg.style.color = "var(--tok-text-secondary)";
    msg.style.wordBreak = "break-all";
    msg.style.maxHeight = (info.canvas.h - 60) + "px";
    msg.style.overflow = "hidden";
    root.appendChild(msg);
    canvas.appendChild(root);
    return canvas;
  }

  HW.renderer = {
    render: render,
    renderError: renderError,
    lintTree: lintTree,
    formatElapsed: formatElapsed,
    composeToCanvas: composeToCanvas,
    loadImage: loadImage,
  };
})(typeof self !== "undefined" ? self : globalThis);
