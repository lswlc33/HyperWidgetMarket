/*
 * ============================================================================
 *  小部件设计工具 · 工作区（打开本地文件夹 = Download/HyperWidget）
 * ============================================================================
 *  目录约定与 App 的 ScriptStore 完全一致：根目录 `*.js` + 同名资源文件夹
 *  （`test1.js` ↔ `test1/`，文件夹里的 `cache/` 是在线资源缓存）。
 *  脚本列表也只列根目录的 .js —— 与 App 的 list() 同口径。
 *
 *  两种实现：
 *   - FsWorkspace：File System Access API（Chromium），可读可写、资源用真实文件；
 *   - ReadonlyWorkspace：<input webkitdirectory> 兜底（Firefox/Safari），只能看不能存。
 * ============================================================================
 */
(function (root) {
  "use strict";
  var HW = (root.HW = root.HW || {});

  var IMAGE_EXT = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg", "avif"];
  var TEXT_EXT = ["txt", "json", "css", "html", "md", "csv", "xml", "log"];

  function ext(name) {
    var i = String(name).lastIndexOf(".");
    return i < 0 ? "" : name.slice(i + 1).toLowerCase();
  }
  function kindOf(name) {
    var e = ext(name);
    if (IMAGE_EXT.indexOf(e) >= 0) return "image";
    if (TEXT_EXT.indexOf(e) >= 0) return "text";
    return "other";
  }
  function mimeOf(name) {
    var e = ext(name);
    if (e === "png") return "image/png";
    if (e === "jpg" || e === "jpeg") return "image/jpeg";
    if (e === "webp") return "image/webp";
    if (e === "gif") return "image/gif";
    if (e === "svg") return "image/svg+xml";
    if (e === "bmp") return "image/bmp";
    if (e === "avif") return "image/avif";
    return "application/octet-stream";
  }

  var MAX_RES_BYTES = 4 * 1024 * 1024;   // 与设备侧图片上限一致

  /* ------------------------------------------------------------ FS Access */

  function FsWorkspace(dirHandle) {
    this.handle = dirHandle;
    this.name = dirHandle.name;
    this.writable = true;
  }

  FsWorkspace.prototype.ensurePermission = async function () {
    var opts = { mode: "readwrite" };
    if (await this.handle.queryPermission(opts) === "granted") return true;
    return (await this.handle.requestPermission(opts)) === "granted";
  };

  /** 列根目录 .js（与 ScriptStore.list 同口径：只列根目录的脚本文件）。 */
  FsWorkspace.prototype.listScripts = async function () {
    var names = [];
    for await (var entry of this.handle.values()) {
      if (entry.kind === "file" && entry.name.toLowerCase().endsWith(".js")) names.push(entry.name);
    }
    return names.sort(function (a, b) { return a.localeCompare(b, "zh"); });
  };

  FsWorkspace.prototype.readScript = async function (name) {
    var fh = await this.handle.getFileHandle(name);
    var file = await fh.getFile();
    return await file.text();
  };

  FsWorkspace.prototype.writeScript = async function (name, text) {
    if (!(await this.ensurePermission())) throw new Error("没有写入权限（重新打开文件夹并允许「编辑」）");
    var fh = await this.handle.getFileHandle(name, { create: true });
    var w = await fh.createWritable();
    await w.write(text);
    await w.close();
  };

  FsWorkspace.prototype.createScript = async function (name, text) {
    await this.writeScript(name, text);
  };

  FsWorkspace.prototype.hasResourceDir = async function (scriptName) {
    try {
      var h = await this.handle.getDirectoryHandle(scriptName.replace(/\.js$/i, ""));
      return !!h;
    } catch (e) {
      return false;
    }
  };

  /**
   * 读脚本资源文件夹（递归，含 cache/）：返回 {rel → Uint8Array}。
   * 超过 4MB 的文件跳过并记一条说明（设备侧图片本来就有这个上限）。
   */
  FsWorkspace.prototype.readResources = async function (scriptName) {
    var dirName = scriptName.replace(/\.js$/i, "");
    var out = {};
    var skipped = [];
    var rootDir;
    try {
      rootDir = await this.handle.getDirectoryHandle(dirName);
    } catch (e) {
      return { files: out, skipped: skipped, dirName: dirName, missing: true };
    }
    async function walk(dir, prefix) {
      for await (var entry of dir.values()) {
        var rel = prefix ? prefix + "/" + entry.name : entry.name;
        if (entry.kind === "directory") {
          await walk(entry, rel);
        } else {
          try {
            var file = await entry.getFile();
            if (file.size > MAX_RES_BYTES) {
              skipped.push({ rel: rel, size: file.size });
              continue;
            }
            out[rel] = new Uint8Array(await file.arrayBuffer());
          } catch (e2) {
            skipped.push({ rel: rel, size: -1 });
          }
        }
      }
    }
    await walk(rootDir, "");
    return { files: out, skipped: skipped, dirName: dirName, missing: false };
  };

  /* --------------------------------------------------------- 只读兜底实现 */

  function ReadonlyWorkspace(files, rootName) {
    this.name = rootName || "已选文件夹";
    this.writable = false;
    this.files = files;   // [{rel, file}]
  }

  ReadonlyWorkspace.prototype.listScripts = async function () {
    var names = [];
    this.files.forEach(function (f) {
      if (f.rel.indexOf("/") < 0 && f.rel.toLowerCase().endsWith(".js")) names.push(f.rel);
    });
    return names.sort(function (a, b) { return a.localeCompare(b, "zh"); });
  };
  ReadonlyWorkspace.prototype.readScript = async function (name) {
    var hit = this.files.find(function (f) { return f.rel === name; });
    if (!hit) throw new Error("找不到文件: " + name);
    return await hit.file.text();
  };
  ReadonlyWorkspace.prototype.writeScript = async function () {
    throw new Error("当前浏览器不支持写入（Firefox/Safari 只能预览）；请用 Chrome/Edge 打开");
  };
  ReadonlyWorkspace.prototype.createScript = ReadonlyWorkspace.prototype.writeScript;
  ReadonlyWorkspace.prototype.readResources = async function (scriptName) {
    var dirName = scriptName.replace(/\.js$/i, "");
    var out = {}, skipped = [], self = this;
    var prefix = dirName + "/";
    var hit = false;
    var jobs = this.files.filter(function (f) { return f.rel.startsWith(prefix); });
    for (var i = 0; i < jobs.length; i++) {
      var f = jobs[i];
      hit = true;
      var rel = f.rel.slice(prefix.length);
      if (f.file.size > MAX_RES_BYTES) { skipped.push({ rel: rel, size: f.file.size }); continue; }
      try {
        out[rel] = new Uint8Array(await f.file.arrayBuffer());
      } catch (e) {
        skipped.push({ rel: rel, size: -1 });
      }
    }
    return { files: out, skipped: skipped, dirName: dirName, missing: !hit };
  };

  /* ------------------------------------------------------------------ 入口 */

  HW.workspace = {
    supported: typeof window !== "undefined" && typeof window.showDirectoryPicker === "function",
    kindOf: kindOf,
    mimeOf: mimeOf,

    /** 打开文件夹（File System Access）。 */
    open: async function () {
      var handle = await window.showDirectoryPicker({ id: "hw-widget-workspace", mode: "readwrite" });
      return new FsWorkspace(handle);
    },

    /** <input webkitdirectory> 兜底：把 FileList 转成 {rel, file} 列表。 */
    fromFileList: async function (fileList) {
      var files = [];
      var root = "";
      for (var i = 0; i < fileList.length; i++) {
        var f = fileList[i];
        var rel = (f.webkitRelativePath || f.name).replace(/\\/g, "/");
        if (!root && rel.indexOf("/") > 0) root = rel.split("/")[0];
        files.push({ rel: rel, file: f });
      }
      var ws = new ReadonlyWorkspace(files, root || "已选文件夹");
      // 去掉最外层目录名，与 FsWorkspace 的相对路径口径对齐
      if (ws.files.every(function (x) { return x.rel.startsWith(ws.name + "/") || x.rel.indexOf("/") < 0; }) && ws.name) {
        ws.files = ws.files.map(function (x) {
          return { rel: x.rel.startsWith(ws.name + "/") ? x.rel.slice(ws.name.length + 1) : x.rel, file: x.file };
        });
      }
      return ws;
    },

    /** 新建脚本的脚手架（与 App 里的一样从最小可用结构起步）。 */
    scaffold: function (name) {
      return [
        "/*",
        " * " + name + " —— 由小部件设计工具创建",
        " * 改完保存（Ctrl+S），到桌面重新添加/刷新小组件即可看到效果。",
        " */",
        "const NAME = \"" + name.replace(/\.js$/i, "") + "\";",
        "const DESCRIPTION = \"\";",
        "const VERSION = \"1.0.0\";",
        "const AUTHOR = \"\";",
        "const SIZES = [\"2x2\", \"4x2\", \"4x4\"];",
        "",
        "function render(ctx) {",
        "  const size = ctx.size();",
        "  return {",
        "    refresh: 60,",
        "    tap: \"refresh\",",
        "    layout: ui.column([",
        "      ui.titleBar({ icon: \"clock\", title: NAME, trailing: ctx.time(\"HH:mm\") }),",
        "      ui.bigNumber(ctx.time(\"HH:mm\"), { unit: \"\" }),",
        "      ui.label(\"画布 \" + size.w + \"×\" + size.h + \"dp（\" + ctx.sizeClass() + \"）\"),",
        "    ], { gap: 6 }),",
        "  };",
        "}",
        "",
      ].join("\n");
    },
  };
})(typeof self !== "undefined" ? self : globalThis);
