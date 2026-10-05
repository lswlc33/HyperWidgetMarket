// ===== 小组件元数据（必填 NAME/DESCRIPTION/VERSION/AUTHOR）=====
const NAME = "系统状态";
const DESCRIPTION = "日期、时钟与整机状态的磁贴仪表盘";
const VERSION = "4.2.0";
const AUTHOR = "澎湃组件";
const SIZES = ["2x2", "4x2", "4x4"];

// 全局变量：应用「变量」页里配置一次，所有脚本共用。
const GLOBALS = {
  clock24: { title: "24 小时制", type: "switch", default: true },
  cpuBars: { title: "CPU 柱状图核数", default: "6" },
  netProbe: { title: "网络探测地址", default: "8.8.8.8" }
};

// 磁贴仪表盘：每块磁贴的尺寸按画布真实尺寸（ctx.size()）算出来，三档都自动铺满。
//
// 关键规则：**磁贴内容行数随磁贴高度自适应**——矮磁贴（<52dp）只放「数值+标签」两行，
// 高磁贴才放「图标+数值+标签」三行。磁贴是固定高度的框（clipToOutline 裁剪），
// 塞超过高度的内容不会报错，只会把最后一行悄悄裁掉——比"信息展示不全"更难排查。
function render(ctx) {
  var b = ctx.battery();
  var mem = readMem(ctx);
  var memPct = mem.total > 0 ? Math.round((mem.total - mem.avail) / mem.total * 100) : 0;
  var memText = ((mem.total - mem.avail) / 1048576).toFixed(1)
    + "/" + (mem.total / 1048576).toFixed(0) + "G";
  var memUsed = ((mem.total - mem.avail) / 1048576).toFixed(0) + "G";
  var net = netInfo(ctx);
  var cores = cpuFreqs(ctx, cpuBarCount(ctx));
  var cpuGhz = (cores.values.length ? cores.sum / cores.values.length / 1000000 : 0).toFixed(1) + "GHz";
  var dev = ctx.device();
  var now = new Date();
  var WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  var month = now.getFullYear() + "年" + (now.getMonth() + 1) + "月";
  var day = "" + now.getDate();
  var weekday = WEEK[now.getDay()];
  var hour24 = ctx.global("clock24", "true") !== "false";
  var fmt = hour24 ? "HH:mm" : "hh:mm";
  var gap = 6;
  var cls = ctx.sizeClass();

  // ---- 2×2：四块磁贴，电量高亮 ----
  if (cls === "2x2") {
    var s2 = ctx.size();
    var W2 = Math.max(80, (s2.w > 0 ? s2.w : 163) - 30);
    var H2 = Math.max(60, (s2.h > 0 ? s2.h : 163) - 40);
    var cw = Math.floor((W2 - gap) / 2);
    var ch = Math.floor((H2 - gap) / 2);
    return { refresh: 30, tap: "config", layout: ui.column([
      ui.row([
        statTile("battery", b.level + "%", "电量", cw, ch, true),
        statTile("square", memPct + "%", "内存", "match", ch, false)
      ], { gap: gap }),
      ui.row([
        statTile("drop", b.tempC.toFixed(0) + "°", "温度", cw, ch, false),
        statTile("wifi", net.ip ? "在线" : "离线", "网络", "match", ch, false)
      ], { gap: gap })
    ], { gap: gap, h: "match", gravity: "center" }) };
  }

  // ---- 4×2 / 4×4 共用数据 ----
  var s = ctx.size();
  var W = Math.max(120, (s.w > 0 ? s.w : 326) - 30);
  var H = Math.max(80, (s.h > 0 ? s.h : 163) - 40);
  // 左列宽度按档位给：4×4 的「2026年10月」五个多全角字符，0.24 的列宽放不下（会被省略号截断）
  var leftW = Math.round(W * (cls === "4x4" ? 0.27 : 0.24));
  var dateH = Math.round((H - gap) * 0.56);
  var ramH = H - dateH - gap;
  var left = ui.column([
    dateTile(leftW, dateH, month, day, weekday),
    ramTile(leftW, ramH, memPct, memText)
  ], { gap: gap, w: leftW, h: H });

  // ---- 4×2：三列。矮磁贴只放数值+标签（放三行必被裁），标签一个不少 ----
  if (cls !== "4x4") {
    var rightW = Math.round(W * 0.27);
    var midW = W - leftW - rightW - 2 * gap;
    var hA = Math.round(H * 0.30);
    var hB = Math.round(H * 0.33);
    var hC = H - hA - hB - 2 * gap;
    var sqW = Math.floor((rightW - gap) / 2);
    // 右列两行小磁贴的高度按「H - 胶囊 - 2gap」切分：直接用 hC 会让右列比中/左列矮
    // （hA + 2*hC + 2*gap ≠ H），三列底边对不齐。余数塞进最后一行，底边严格补齐。
    var rh2 = Math.floor((H - hA - 2 * gap) / 2);
    var rem2 = H - hA - 2 * gap - 2 * rh2;
    var wifiW = Math.round(midW * 0.34);
    return { refresh: 30, tap: "config", layout: ui.row([
      left,
      ui.column([
        ui.row([
          imageTile("mascot", "WiFi " + (net.ip ? "在线" : "离线"), wifiW, hA, false),
          clockTile(midW - wifiW - gap, hA, fmt)
        ], { gap: gap }),
        heroTile("处理器", cpuGhz, "match", hB),
        ui.row([
          statTile("", b.tempC.toFixed(0) + "°", "温度", sqW, hC, false),
          statTile("", b.powerW.toFixed(1) + "W", "功率", "match", hC, false)
        ], { gap: gap })
      ], { gap: gap, w: midW, h: H }),
      ui.column([
        pillTile("电量 " + b.level + "%", "match", hA),
        ui.row([
          statTile("", uptimeShort(ctx), "开机", sqW, rh2, false),
          statTile("", "" + (dev.androidVersion || "--"), "安卓", "match", rh2, false)
        ], { gap: gap }),
        ui.row([
          statTile("", b.voltageV.toFixed(1) + "V", "电压", sqW, rh2 + rem2, false),
          statTile("", (b.currentMa / 1000).toFixed(1) + "A", "电流", "match", rh2 + rem2, false)
        ], { gap: gap })
      ], { gap: gap, w: "match", h: H })
    ], { gap: gap, h: "match", gravity: "center" }) };
  }

  // ---- 4×4：左列两块高磁贴 + 右区 5 行 × 3 列（15 块磁贴，比 4×2 多 4 项信息） ----
  var gridW = W - leftW - gap;
  var rows = 5;
  var rh = Math.floor((H - (rows - 1) * gap) / rows);
  var rem = H - (rows - 1) * gap - rows * rh;   // 整除余数塞进首行，右区底边与左列对齐
  var col3 = Math.floor((gridW - 2 * gap) / 3);
  var span2 = gridW - col3 - gap;
  return { refresh: 30, tap: "config", layout: ui.row([
    left,
    ui.column([
      ui.row([
        imageTile("mascot", "WiFi " + (net.ip ? "在线" : "离线"), col3, rh + rem, false),
        clockTile(span2, rh + rem, fmt)
      ], { gap: gap }),
      ui.row([
        pillTile("电量 " + b.level + "%", col3, rh),
        statTile("", memPct + "%", "内存", col3, rh, false),
        statTile("", b.tempC.toFixed(0) + "°", "温度", "match", rh, false)
      ], { gap: gap }),
      ui.row([
        heroTile("处理器", cpuGhz, span2, rh),
        statTile("", b.powerW.toFixed(1) + "W", "功率", "match", rh, false)
      ], { gap: gap }),
      ui.row([
        statTile("", memUsed, "存储", col3, rh, false),
        statTile("", uptimeShort(ctx), "开机", col3, rh, false),
        statTile("", b.charging ? "充电" : "放电", "状态", "match", rh, false)
      ], { gap: gap }),
      ui.row([
        statTile("", b.voltageV.toFixed(1) + "V", "电压", col3, rh, false),
        statTile("", (b.currentMa / 1000).toFixed(1) + "A", "电流", col3, rh, false),
        statTile("", "" + (dev.androidVersion || "--"), "安卓", "match", rh, false)
      ], { gap: gap })
    ], { gap: gap, w: "match", h: H })
  ], { gap: gap, h: "match", gravity: "center" }) };
}

// ---------------------------------------------------------------- 磁贴

function tileBg(w, h, hl) {
  // 内边距封顶 6dp：fitFont 估可用宽度时按「左右共 12dp」扣的，两边必须一致，
  // 否则估出的字号偏大、文本又被磁贴裁掉
  return { w: w, h: h, bg: hl ? "accent" : "surface", radius: 14,
    padding: clamp(Math.round(h * 0.05), 3, 6) };
}

// 图片磁贴：内置资源（res 名见手册 §5.2）铺在圆角底板上，配一行小标签。
// 图片边长要给「图片 + 标签 + 间距」的总高留够：有标签占短边 52%，无标签占 78%——
// 占比给大了标签会被磁贴底边裁掉（固定高度的框，超出的内容静默消失）。
function imageTile(res, label, w, h, hl) {
  var ew = typeof w === "number" ? w : 90;
  var short = Math.min(ew, h);
  var showLabel = !!label && h >= 52;
  var side = Math.max(18, Math.round(short * (showLabel ? 0.52 : 0.78)));
  var kids = [
    { type: "image", res: res, w: side, h: side }
  ];
  if (showLabel) {
    kids.push(ui.text(label, {
      size: fitFont(Math.round(h * 0.16), ew, label, 8, 12),
      color: hl ? "primary" : "secondary", maxLines: 1
    }));
  }
  return ui.box([ui.column(kids, { w: "match", h: "match", gravity: "center", gap: 2 })], tileBg(w, h, hl));
}

// 数据磁贴：h≥52 放「图标+数值+标签」三行；更矮只放「数值+标签」两行（放三行必被裁）。
// 字号由 fitFont 按磁贴宽度和文本长度收口，保证不溢出。
function statTile(icon, value, label, w, h, hl) {
  var ew = typeof w === "number" ? w : 90;
  var three = h >= 52;
  var kids = [];
  if (three && icon) kids.push(ui.icon(icon, { size: clamp(Math.round(h * 0.24), 9, 22), color: hl ? "primary" : "accent" }));
  if (value) kids.push(ui.text(value, {
    size: fitFont(Math.round(h * (three ? 0.30 : 0.33)), ew, value, 9, 30),
    bold: true, color: "primary", maxLines: 1
  }));
  if (label) kids.push(ui.text(label, {
    size: fitFont(Math.round(h * (three ? 0.15 : 0.17)), ew, label, 8, 12),
    color: hl ? "primary" : "secondary", maxLines: 1
  }));
  return ui.box([ui.column(kids, { w: "match", h: "match", gravity: "center", gap: 1 })], tileBg(w, h, hl));
}

// 小字在上、大字在下的「主角」磁贴（处理器频率那块）
function heroTile(label, value, w, h) {
  var ew = typeof w === "number" ? w : 120;
  return ui.box([ui.column([
    ui.text(label, { size: fitFont(Math.round(h * 0.16), ew, label, 9, 13), color: "secondary", maxLines: 1 }),
    ui.text(value, { size: fitFont(Math.round(h * 0.40), ew, value, 13, 44), bold: true, color: "primary", maxLines: 1 })
  ], { w: "match", h: "match", gravity: "center", gap: 2 })], tileBg(w, h, false));
}

// 走字时钟磁贴（系统 TextClock，不依赖刷新）。w 必须给真实宽度，估字号才准。
function clockTile(w, h, fmt) {
  return ui.box([ui.column([
    ui.clock({ format: fmt, size: fitFont(Math.round(h * 0.52), w, "23:30", 14, 40), color: "primary" })
  ], { w: "match", h: "match", gravity: "center" })], tileBg(w, h, false));
}

// 内存磁贴：标签 + 进度条 + 占用
function ramTile(w, h, pct, text) {
  return ui.box([ui.column([
    ui.text("内存", { size: fitFont(Math.round(h * 0.11), w, "内存", 9, 13), color: "secondary", maxLines: 1 }),
    ui.progress(pct, 100),
    ui.text(text, { size: fitFont(Math.round(h * 0.20), w, text, 10, 22), bold: true, color: "primary", maxLines: 1 })
  ], { w: "match", h: "match", gravity: "center", gap: 2 })], tileBg(w, h, false));
}

// 日期磁贴：年月 / 大号日期 / 星期
function dateTile(w, h, month, day, weekday) {
  return ui.box([ui.column([
    ui.text(month, { size: fitFont(Math.round(h * 0.12), w, month, 9, 14), color: "secondary", maxLines: 1 }),
    ui.text(day, { size: fitFont(Math.round(h * 0.40), w, day, 14, 46), bold: true, color: "primary", maxLines: 1 }),
    ui.text(weekday, { size: fitFont(Math.round(h * 0.12), w, weekday, 9, 14), color: "secondary", maxLines: 1 })
  ], { w: "match", h: "match", gravity: "center", gap: 1 })], tileBg(w, h, false));
}

// 高亮胶囊（accent 底）：纯文字（参考图同款），文字可用宽度就是磁贴内宽
function pillTile(text, w, h) {
  var ew = typeof w === "number" ? w : 90;
  return ui.box([ui.column([
    ui.text(text, { size: fitFont(Math.round(h * 0.36), ew, text, 10, 26), bold: true, color: "primary", maxLines: 1 })
  ], { w: "match", h: "match", gravity: "center" })], tileBg(w, h, true));
}

// 字号：高度给基准，再按逐字符估宽收口（CJK 1.0em、其余 0.6em），保证不溢出磁贴
function fitFont(hBase, w, text, lo, hiCap) {
  var ems = 0;
  for (var i = 0; i < text.length; i++) ems += text.charCodeAt(i) > 0x2E80 ? 1.0 : 0.6;
  // 1.08 安全系数：粗体和不同字体的实际字宽会波动，卡着估就会溢出成省略号
  var byW = Math.floor((w - 12) / Math.max(1, ems * 1.08));
  return clamp(Math.min(hBase, byW), lo, hiCap || 44);
}

function clamp(v, lo, hi) {
  if (hi < lo) hi = lo;
  return Math.max(lo, Math.min(v, hi));
}

// ---------------------------------------------------------------- 数据

// /proc/meminfo 只有 kB 字段；Android 10+ 普通应用可读
function readMem(ctx) {
  var text = "";
  try { text = ctx.file("/proc/meminfo"); } catch (e) { return { total: 0, avail: 0 }; }
  var lines = text.split("\n");
  function kb(key) {
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf(key) === 0) return parseInt(lines[i].replace(/[^0-9]/g, ""), 10) || 0;
    }
    return 0;
  }
  return { total: kb("MemTotal"), avail: kb("MemAvailable") };
}

// CPU 当前频率（kHz）：/sys 世界可读，不需要 root
function cpuFreqs(ctx, n) {
  var values = [], max = 1, sum = 0;
  for (var i = 0; i < n; i++) {
    var khz = 0;
    try {
      khz = parseInt(ctx.file("/sys/devices/system/cpu/cpu" + i + "/cpufreq/scaling_cur_freq"), 10) || 0;
    } catch (e) {}
    if (khz > max) max = khz;
    sum += khz;
    values.push(khz);
  }
  return { values: values, max: max, sum: sum };
}

function cpuBarCount(ctx) {
  var n = parseInt(ctx.global("cpuBars", "6"), 10);
  if (isNaN(n) || n < 1) n = 6;
  return Math.min(8, n);
}

// 出口 IP：HyperOS 的默认路由在独立路由表，ip route get 一次拿全（需要 root 授权；
// 没授权时 shell 返回空串，这里回落到「离线」而不是抛错）
function netInfo(ctx) {
  var ip = "", gw = "";
  var probe = ctx.global("netProbe", "8.8.8.8");
  try {
    var out = ctx.shell("ip route get " + probe);
    var s = out.match(/src\s+([0-9.]+)/);
    if (s) ip = s[1];
  } catch (e) {}
  if (!ip) {
    try {
      var w = ctx.shell("ip -4 addr show wlan0").match(/inet\s+([0-9.]+)/);
      if (w) ip = w[1];
    } catch (e) {}
  }
  return { ip: ip, gw: gw };
}

// 磁贴里放得下的短时长
function uptimeShort(ctx) {
  var sec = ctx.uptime();
  var d = Math.floor(sec / 86400);
  if (d > 0) return d + "天";
  var h = Math.floor(sec / 3600);
  if (h > 0) return h + "h";
  return Math.floor(sec / 60) + "m";
}
