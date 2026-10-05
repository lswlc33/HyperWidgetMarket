/*
 * ============================================================================
 *  小部件设计工具 · 脚本执行 worker
 * ============================================================================
 *  为什么要有 worker：脚本是同步阻塞的（设备上也是），一个 while(true) 就能冻住整页。
 *  主线程 8 秒收不到结果就 terminate 重建，编辑器与预览不受影响；顺便把脚本与工具的
 *  作用域隔开（脚本拿不到 document / localStorage）。
 *
 *  这里实现的是 ctx 的**网页侧 mock**，逐条对照 JsBridge.java：
 *    - battery/time/uptime/size/sizeClass/meta/device  → 面板里造的数据
 *    - file                                          → 脚本资源文件夹内存表
 *    - shell                                         → mock 表（JSON），未命中给 ""+告警
 *    - http/httpBinary/json                          → mock 表 → 真 fetch → 资源文件夹 cache/
 *    - store/env/global/var                          → 主线程传入的快照 + 回写
 *  失败语义（报错文案）与设备保持一致，见 docs/网页设计工具计划.md §3.3。
 * ============================================================================
 */
importScripts("engine.js");

var HW = self.HW;

/* ------------------------------------------------------------------ 小工具 */

function b64FromBytes(bytes) {
  var chunk = 0x8000;
  var out = "";
  for (var i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(out);
}

function bytesFromB64(b64) {
  var bin = atob(String(b64).replace(/\s/g, ""));
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function fetchWithTimeout(url, opts, ms) {
  var ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  var timer = ctl ? setTimeout(function () { ctl.abort(); }, ms || 8000) : null;
  var init = Object.assign({}, opts || {});
  init.headers = Object.assign({ "User-Agent": "HyperWidget/1.0" }, init.headers || {});
  if (ctl) init.signal = ctl.signal;
  return fetch(url, init).finally(function () { if (timer) clearTimeout(timer); });
}

/* ------------------------------------------------------------------- 运行 */

var startedAt = Date.now();

/** 建一个 ctx 对象（每次运行新建，与设备一致）。 */
function buildCtx(opt) {
  var logs = [];
  var storeWrites = {};
  var warnings = [];
  var data = opt.data || {};
  var mocks = opt.mocks || {};
  var resources = opt.resources || {};
  var proxy = (opt.httpProxy || "").trim();
  var isDark = opt.theme === "dark";

  function mockFor(key) {
    return Object.prototype.hasOwnProperty.call(mocks, key) ? mocks[key] : undefined;
  }
  function warn(msg) {
    if (warnings.indexOf(msg) < 0) warnings.push(msg);
  }
  function fullUrl(url) {
    return proxy ? proxy + encodeURIComponent(url) : url;
  }

  function httpText(url) {
    var mock = mockFor("http:" + url);
    if (mock !== undefined) return typeof mock === "string" ? mock : JSON.stringify(mock);
    if (!opt.allowNetwork) throw "网络已关闭（数据面板里可开）";
    // 设备侧是同步阻塞，这里只能同步不了：走 XHR 同步请求（worker 里允许），
    // 保证脚本看到的调用形态与设备一致（返回值而不是 Promise）。
    var xhr = new XMLHttpRequest();
    xhr.open("GET", fullUrl(url), false);
    xhr.setRequestHeader("User-Agent", "HyperWidget/1.0");
    try {
      xhr.send(null);
    } catch (e) {
      throw "网络请求失败: " + (e && e.message ? e.message : "未知错误");
    }
    if (xhr.status >= 400) throw "HTTP " + xhr.status;
    return xhr.responseText.trim();
  }

  function httpBinaryBytes(url) {
    var mock = mockFor("httpbin:" + url);
    if (mock !== undefined) return bytesFromB64(mock);
    // 真机下载过的缓存：资源文件夹 cache/<md5前10>-<末段>（ScriptStore.cacheFileName）
    var cachedName = "cache/" + HW.util.cacheFileName(url);
    if (resources[cachedName]) return resources[cachedName];
    if (!opt.allowNetwork) throw "网络已关闭（数据面板里可开）";
    var xhr = new XMLHttpRequest();
    xhr.open("GET", fullUrl(url), false);
    xhr.responseType = "arraybuffer";
    xhr.setRequestHeader("User-Agent", "HyperWidget/1.0");
    try {
      xhr.send(null);
    } catch (e) {
      throw "图片下载失败: " + (e && e.message ? e.message : "未知错误") + "（" + url + "）";
    }
    if (xhr.status >= 400) throw "HTTP " + xhr.status;
    var buf = new Uint8Array(xhr.response || new ArrayBuffer(0));
    if (buf.length > 4 * 1024 * 1024) throw "下载内容超过 4MB 上限";
    return buf;
  }

  var dataBattery = data.battery || {};
  var dataDevice = data.device || {};
  var dataMeta = opt.meta || {};
  var size = opt.size || { w: 0, h: 0 };

  var ctx = {
    /* ---- 设备数据 ---- */
    battery: function () {
      var ma = Number(dataBattery.currentMa || 0);
      var v = Number(dataBattery.voltageV || 0);
      return {
        level: Number(dataBattery.level || 0),
        charging: !!dataBattery.charging,
        plugged: !!dataBattery.plugged,
        currentMa: ma,
        voltageV: v,
        tempC: Number(dataBattery.tempC || 0),
        powerW: (ma / 1000) * v,
      };
    },
    time: function (pattern) {
      var p = pattern === null || pattern === undefined ? null : String(pattern);
      if (p === null || p.trim() === "") p = "HH:mm";
      return HW.util.formatTime(p, new Date());
    },
    uptime: function () { return (Date.now() - startedAt) / 1000; },
    device: function () {
      return {
        model: dataDevice.model || "网页预览",
        androidVersion: dataDevice.androidVersion || "15",
        isDarkMode: isDark,
      };
    },
    size: function () { return { w: size.w, h: size.h }; },
    sizeClass: function () { return HW.sizeClassOf(size.w, size.h); },
    meta: function () {
      return {
        name: dataMeta.name === undefined ? null : dataMeta.name,
        description: dataMeta.description === undefined ? null : dataMeta.description,
        version: dataMeta.version === undefined ? null : dataMeta.version,
        author: dataMeta.author === undefined ? null : dataMeta.author,
        sizes: (dataMeta.sizes || []).slice(),
        updatedAt: dataMeta.updatedAt === undefined ? null : dataMeta.updatedAt,
        widgetId: -100,
        isPreview: true,
      };
    },

    /* ---- 文件 / 命令 ---- */
    file: function (path, root) {
      var p = path === null || path === undefined ? null : String(path);
      if (p === null || p.trim() === "") throw "file(path) 需要路径";
      if (root) warn("ctx.file(path, true) 在网页里读的是脚本资源文件夹，不走 su");
      var rel = HW.resolveResourcePath(p);
      var bytes = rel ? resources[rel] : undefined;
      if (!bytes) throw "文件不存在: " + p;
      var text = new TextDecoder("utf-8").decode(bytes);
      return text.trim();
    },
    shell: function (cmd, root) {
      var c = cmd === null || cmd === undefined ? null : String(cmd);
      if (c === null || c.trim() === "") throw "shell(cmd) 需要命令";
      var mock = mockFor("shell:" + c);
      if (mock !== undefined) return String(mock);
      warn("未模拟的命令（数据面板 → shell mock 可造返回值）: " + c);
      return "";
    },

    /* ---- 网络 ---- */
    http: function (a, b) {
      if (a !== null && typeof a === "object") {
        var url = a.url;
        if (url === null || url === undefined) throw "http(options) 需要 url 字段";
        url = String(url);
        var method = a.method === null || a.method === undefined ? "GET" : String(a.method).trim().toUpperCase();
        if (["GET", "POST", "PUT", "DELETE", "HEAD"].indexOf(method) < 0) {
          throw "http(options) 不支持方法: " + method;
        }
        var mock = mockFor("http:" + url);
        if (mock !== undefined) {
          if (typeof mock === "object" && mock !== null) {
            return {
              status: Number(mock.status || 200),
              ok: mock.status ? Number(mock.status) < 400 : true,
              body: mock.body === undefined ? JSON.stringify(mock) : String(mock.body),
            };
          }
          return { status: 200, ok: true, body: String(mock) };
        }
        if (!opt.allowNetwork) throw "网络已关闭（数据面板里可开）";
        var xhr = new XMLHttpRequest();
        xhr.open(method, fullUrl(url), false);
        xhr.setRequestHeader("User-Agent", "HyperWidget/1.0");
        if (a.headers && typeof a.headers === "object") {
          Object.keys(a.headers).forEach(function (k) {
            if (a.headers[k] !== null && a.headers[k] !== undefined) xhr.setRequestHeader(k, String(a.headers[k]));
          });
        }
        var body = a.body === null || a.body === undefined ? null : String(a.body);
        try {
          xhr.send(method === "GET" || method === "HEAD" ? null : body);
        } catch (e) {
          throw "网络请求失败: " + (e && e.message ? e.message : "未知错误");
        }
        return {
          status: xhr.status,
          ok: xhr.status < 400,
          body: xhr.responseText === undefined ? "" : String(xhr.responseText),
        };
      }
      var u = a === null || a === undefined ? null : String(a);
      if (u === null || u.trim() === "") throw "http(url) 需要地址";
      return httpText(u);
    },
    httpBinary: function (url) {
      var u = url === null || url === undefined ? null : String(url);
      if (u === null || u.trim() === "") throw "httpBinary(url) 需要地址";
      return b64FromBytes(httpBinaryBytes(u));
    },
    json: function (text) {
      if (text === null || text === undefined) throw "json(text) 需要 JSON 字符串";
      var s = String(text).trim();
      if (!s.startsWith("{") && !s.startsWith("[")) throw "不是 JSON 对象或数组";
      return JSON.parse(s);
    },

    /* ---- 日志 / 存储 ---- */
    log: function (msg) {
      logs.push(msg === undefined ? "undefined" : String(msg));
    },
    storeGet: function (key) {
      var k = String(key === undefined ? null : key);
      return Object.prototype.hasOwnProperty.call(opt.store || {}, k) ? (opt.store || {})[k] : null;
    },
    storeSet: function (key, value) {
      var k = String(key === undefined ? null : key);
      var v = value === null || value === undefined ? null : String(value);
      storeWrites[k] = v;
      opt.store = Object.assign({}, opt.store || {});
      if (v === null) delete opt.store[k];
      else opt.store[k] = v;
    },

    /* ---- 变量（三级回退链，对齐 ScriptStore） ---- */
    env: function (key, fallback) {
      var k = key === null || key === undefined ? null : String(key);
      if (k === null || k.trim() === "") throw "env(key) 需要键名";
      var fb = arguments.length > 1 && fallback !== undefined ? String(fallback) : null;
      var vals = opt.envValues || {};
      if (Object.prototype.hasOwnProperty.call(vals, k) && vals[k] !== "") return String(vals[k]);
      var d = opt.envDefaults || {};
      if (Object.prototype.hasOwnProperty.call(d, k)) return String(d[k]);
      return fb;
    },
    global: function (key, fallback) {
      var k = key === null || key === undefined ? null : String(key);
      if (k === null || k.trim() === "") throw "global(key) 需要键名";
      var fb = arguments.length > 1 && fallback !== undefined ? String(fallback) : null;
      var vals = opt.globalValues || {};
      if (Object.prototype.hasOwnProperty.call(vals, k) && vals[k] !== "") return String(vals[k]);
      var d = opt.globalDefaults || {};
      if (Object.prototype.hasOwnProperty.call(d, k)) return String(d[k]);
      return fb;
    },
    var: function (key, fallback) {
      var v = ctx.env(key);
      if (v !== null) return v;
      v = ctx.global(key);
      if (v !== null) return v;
      return arguments.length > 1 && fallback !== undefined ? String(fallback) : null;
    },
  };

  return { ctx: ctx, logs: logs, storeWrites: storeWrites, warnings: warnings, httpBinaryBytes: httpBinaryBytes, httpText: httpText };
}

/**
 * 把 image 节点的 url 在脚本执行期解析成 b64 / cache 路径
 * （JsBridge.resolveImageUrls 移植：path 优先、uri:true 只落缓存文件名）。
 */
function resolveImageUrls(node, api) {
  if (!node || typeof node !== "object") return;
  if (node.type === "image" && node.url !== undefined && node.url !== null && node.path == null) {
    var url = String(node.url).trim();
    var bytes = api.httpBinaryBytes(url);
    if (node.uri) {
      node.file = "cache/" + HW.util.cacheFileName(url);
    } else {
      node.b64 = b64FromBytes(bytes);
    }
    delete node.url;
  }
  var ch = node.children;
  if (Array.isArray(ch)) for (var i = 0; i < ch.length; i++) resolveImageUrls(ch[i], api);
}

self.onmessage = function (ev) {
  var msg = ev.data || {};
  if (msg.type !== "run") return;
  var runId = msg.runId;
  var out = { type: "result", runId: runId, ok: false, logs: [], warnings: [], storeWrites: {} };
  var api = null;
  try {
    // 组件库：与 JsBridge.bindUiLib 同款——独立作用域求值，只把 ui 对象挂进脚本作用域
    var uiObj = undefined;
    if (msg.uiSource) {
      try {
        var libFn = new Function(msg.uiSource + "\n;return typeof ui === 'object' ? ui : undefined;");
        uiObj = libFn();
      } catch (e) {
        out.warnings.push("组件库求值失败（脚本里 ui 不可用）: " + e.message);
      }
    } else {
      out.warnings.push("未读到 widget-ui.js（ui.* 不可用）——请确认用仓库根目录起的本地服务器打开");
    }

    var built = buildCtx(msg);
    api = built;
    out.logs = built.logs;
    out.warnings = out.warnings.concat(built.warnings);
    out.storeWrites = built.storeWrites;

    var runner;
    try {
      runner = new Function("ctx", "ui", msg.code +
        "\n;return { render: typeof render === 'function' ? render : null };");
    } catch (e) {
      throw { phase: "eval", message: "脚本执行出错: " + e.message, stack: e.stack };
    }
    var env;
    try {
      env = runner(built.ctx, uiObj);
    } catch (e) {
      throw { phase: "eval", message: "脚本执行出错: " + (e && e.message ? e.message : String(e)), stack: e && e.stack };
    }
    if (!env.render) throw { phase: "eval", message: "脚本必须定义 function render(ctx)" };

    var ret;
    try {
      ret = env.render(built.ctx);
    } catch (e) {
      throw { phase: "render", message: "render() 执行出错: " + (e && e.message ? e.message : String(e)), stack: e && e.stack };
    }
    if (ret === null || ret === undefined || typeof ret !== "object" || Array.isArray(ret)) {
      throw { phase: "render", message: "render() 必须返回对象" };
    }

    resolveImageUrls(ret.layout, built);

    var spec;
    try {
      spec = HW.parseSpec(ret);
    } catch (e) {
      throw { phase: "spec", message: e.message, stack: e.stack };
    }

    out.ok = true;
    out.spec = spec;
    out.logs = built.logs;
    out.storeWrites = built.storeWrites;
    out.warnings = out.warnings.concat(built.warnings);
  } catch (e) {
    if (e && e.phase) {
      out.error = { phase: e.phase, message: e.message, stack: e.stack || null };
    } else {
      out.error = {
        phase: "eval",
        message: "脚本执行出错: " + (e && e.message ? e.message : String(e)),
        stack: e && e.stack ? e.stack : null,
      };
    }
    if (api) {
      out.logs = api.logs;
      out.warnings = out.warnings.concat(api.warnings);
      out.storeWrites = api.storeWrites;
    }
  }
  self.postMessage(out);
};
