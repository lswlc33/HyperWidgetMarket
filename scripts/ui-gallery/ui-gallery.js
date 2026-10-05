// ===== 小组件元数据（必填 NAME/DESCRIPTION/VERSION/AUTHOR）=====
const NAME = "组件库";
const DESCRIPTION = "内置组件库 ui.* 的用法示例";
const VERSION = "2.0.0";
const AUTHOR = "澎湃组件";
const SIZES = ["2x2", "4x2", "4x4"];

// 全局变量：应用「变量」页里配置一次，所有脚本共用（与「系统状态」共用 cpuBars）。
const GLOBALS = {
  cpuBars: { title: "CPU 柱状图核数", default: "6" }
};

// 这个脚本本身就是「用组件库写脚本」的范例：布局全部由 ui.* 生成，
// 标签直接写上组件名，方便对照 docs/小组件开发手册.md 第 5 章。
function render(ctx) {
  var b = ctx.battery();
  var state = b.charging ? "充电中" : (b.plugged ? "已插电" : "放电中");

  // 2×2：组件库最小的组合（标题栏 + 大数字 + 仪表）
  if (ctx.sizeClass() === "2x2") {
    return { refresh: 30, tap: "config", layout: ui.column([
      ui.titleBar({ icon: "star", title: NAME }),
      ui.bigNumber(b.level, { unit: "%" }),
      ui.gauge({ value: b.level, max: 100 })
    ], { w: "match", h: "match", gravity: "center", gap: 6 }) };
  }

  // 4×2：并排指标 + 仪表。
  // 4×2 实际画布只有 ~159dp 高（名义 163dp），塞四段内容就会顶到圆角上——
  // 这里只留三段，chip / stack 那些留给空间充裕的 4×4。
  if (ctx.sizeClass() === "4x2") {
    return { refresh: 30, tap: "config", layout: ui.column([
      ui.titleBar({ icon: "star", title: NAME, trailing: "ui " + ui.VERSION }),
      ui.statRow([
        { value: b.level + "%", label: "bigNumber" },
        { value: b.tempC.toFixed(1) + "°", label: "statRow" },
        { value: b.powerW.toFixed(2) + "W", label: "kvRows" }
      ]),
      ui.gauge({ value: b.level, max: 100, label: "gauge · 电量", text: b.level + "%" })
    ], { gap: 12 }) };
  }

  // 4×4：标题栏 / chip / 大数字 / 仪表 / 指标行 / 键值行 / 分隔线 / 柱状图 一次看全
  var cores = cpuFreqs(ctx, cpuBarCount(ctx));
  var labels = [];
  for (var i = 0; i < cores.values.length; i++) labels.push("" + i);
  var avg = cores.values.length > 0 ? (cores.sum / cores.values.length / 1000000).toFixed(2) : "0.00";
  // 4×4 画布比名义高（本机实测 365dp），柱状图和行距跟着画布长高，把画布铺满
  var canvasH = ctx.size().h > 0 ? ctx.size().h : 326;
  var chartH = Math.max(30, Math.min(64, Math.round(canvasH * 0.16)));

  return { refresh: 30, tap: "config", layout: ui.column([
    ui.titleBar({ icon: "star", title: NAME, trailing: state }),
    ui.row([
      ui.chip("titleBar"),
      ui.chip("chip"),
      // stack 叠放容器：FrameLayout 里 w:"match" 不生效，底和字都要给尺寸；
      // stack 自身给 w:"wrap" 才会贴着底的大小
      ui.stack([
        ui.box([], { w: 78, h: 22, bg: "surface", radius: 11 }),
        ui.text("stack", { size: 11, color: "accent", w: 78, h: 22, align: "center" })
      ], { w: "wrap" })
    ], { gap: 6 }),
    ui.bigNumber(b.level, { unit: "%" }),
    ui.gauge({ value: b.level, max: 100, label: "gauge · 电量", text: b.level + "%" }),
    ui.divider(),
    ui.kvRows([
      ["功率", b.powerW.toFixed(2) + " W"],
      ["电流", b.currentMa.toFixed(0) + " mA"],
      ["电压", b.voltageV.toFixed(2) + " V"]
    ]),
    ui.divider(),
    ui.text("barChart · CPU 各核频率 · 平均 " + avg + " GHz", { size: 11, color: "secondary" }),
    ui.barChart({ values: cores.values, max: cores.max, labels: labels, height: chartH, barWidth: 18, gap: 4 })
    // 同「系统状态」：4×4 画布比名义高，整块内容垂直居中，避免底部留大片空白
  ], { gap: 4, h: "match", gravity: "center" }) };
}

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
