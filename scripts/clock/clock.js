// ===== 小组件元数据（必填 NAME/DESCRIPTION/VERSION/AUTHOR）=====
const NAME = "时钟";
const DESCRIPTION = "走字时钟、日期与时间进度";
const VERSION = "2.0.0";
const AUTHOR = "澎湃组件";
const SIZES = ["2x2", "4x2", "4x4"];

// 全局变量：应用「变量」页里配置一次，所有脚本共用，用 ctx.global(key) 读取。
const GLOBALS = {
  clock24: { title: "24 小时制", type: "switch", default: true },
  clockSeconds: { title: "时钟显示秒", type: "switch", default: false }
};

// clock 节点是系统 TextClock：时间自动走字，不依赖脚本刷新。
// 2×2 只有时间与日期；4×2 追加当天进度；4×4 再补本周/本月进度与电量、开机时长。
function render(ctx) {
  var now = new Date();
  var WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  var date = now.getFullYear() + "/" + pad2(now.getMonth() + 1) + "/" + pad2(now.getDate());
  var weekday = WEEK[now.getDay()];
  var hour24 = ctx.global("clock24", "true") !== "false";
  var fmt = (hour24 ? "HH:mm" : "hh:mm")
    + (ctx.global("clockSeconds", "false") === "true" ? ":ss" : "");

  var secOfDay = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  var dayPct = Math.round(secOfDay / 864);                    // secOfDay / 86400 * 100
  var dow = (now.getDay() + 6) % 7;                           // 0 = 周一
  var weekPct = Math.round((dow + secOfDay / 86400) / 7 * 100);
  var daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  var monthPct = Math.round((now.getDate() - 1 + secOfDay / 86400) / daysInMonth * 100);

  if (ctx.sizeClass() === "2x2") {
    // h:"match" + gravity:"center"：整块内容在画布内垂直水平居中
    return { refresh: 60, tap: "config", layout: {
      type: "column", w: "match", h: "match", gravity: "center", gap: 3, children: [
        { type: "clock", format: fmt, size: 30, color: "primary" },
        { type: "text", text: weekday, size: 12, color: "secondary" },
        { type: "text", text: date, size: 11, color: "secondary" }
      ]
    }};
  }

  if (ctx.sizeClass() === "4x2") {
    return { refresh: 60, tap: "config", layout: ui.column([
      ui.titleBar({ icon: "clock", title: NAME, trailing: weekday }),
      { type: "row", gap: 10, children: [
        { type: "clock", format: fmt, size: 42, color: "primary" },
        { type: "column", w: "match", gravity: "end", gap: 2, children: [
          { type: "text", text: date, size: 11, color: "secondary" },
          { type: "text", text: "今天已过 " + dayPct + "%", size: 12, color: "primary" }
        ]}
      ]},
      ui.gauge({ value: dayPct, max: 100 }),
      ui.text("电量 " + ctx.battery().level + "% · 已开机 " + uptimeText(ctx),
        { size: 11, color: "secondary" })
    ], { gap: 10 }) };
  }

  // 4×4：大时钟居中 + 今天/本周/本月三条进度 + 电量与开机时长。
  // 画布高度随机型/拖拽变化（本机实测 365dp，名义 326dp），所以：
  // 1. 大时钟字号跟着画布高度缩放，画布高就写大点，不浪费空间；
  // 2. 整块内容垂直居中（多出来的空间上下均分），不会在底部留一大片空白。
  // 注意：内层 column 的 h:"match" 在 LinearLayout 里不会撑开（不分配剩余高度），
  // 所以居中要写在根节点上。
  var canvasH = ctx.size().h > 0 ? ctx.size().h : 326;
  var bigClock = Math.max(44, Math.min(78, Math.round(canvasH * 0.205)));
  var gap4 = Math.max(6, Math.min(12, Math.round(canvasH * 0.025)));
  return { refresh: 60, tap: "config", layout: ui.column([
    ui.titleBar({ icon: "clock", title: NAME, trailing: weekday }),
    { type: "column", w: "match", gravity: "center", gap: 2, children: [
      { type: "clock", format: fmt, size: bigClock, color: "primary" },
      { type: "text", text: date, size: 12, color: "secondary" }
    ]},
    ui.divider(),
    ui.gauge({ value: dayPct, max: 100, label: "今天", text: dayPct + "%" }),
    ui.gauge({ value: weekPct, max: 100, label: "本周", text: weekPct + "%" }),
    ui.gauge({ value: monthPct, max: 100, label: "本月", text: monthPct + "%" }),
    ui.text("电量 " + ctx.battery().level + "% · 已开机 " + uptimeText(ctx),
      { size: 11, color: "secondary", w: "match", align: "center" })
  ], { gap: gap4, h: "match", gravity: "center" }) };
}

function pad2(n) {
  return n < 10 ? "0" + n : "" + n;
}

// 开机时长：Android 10+ 读不到 /proc/uptime，走 ctx.uptime()
function uptimeText(ctx) {
  var sec = ctx.uptime();
  var h = Math.floor(sec / 3600);
  var m = Math.floor(sec % 3600 / 60);
  return h > 0 ? h + " 小时 " + m + " 分" : m + " 分钟";
}
