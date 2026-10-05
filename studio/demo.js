/*
 * 小部件设计工具 · 内置示例脚本
 * ============================================================================
 *  没有打开文件夹时工具就渲染这一份，用来验证"改一行 → 右边立刻变"这条链路。
 *  它同时是脚本模板：组件库（ui.*）的常用组件都能在这里找到例子，
 *  （titleBar / bigNumber / gauge / statRow / iconStat / barChart / card / chip /
 *   grid / stack / image / clock / progress …，其余见 docs/小组件开发手册.md §5）
 *  而且它本身是**合法的小部件脚本**——复制到 Download/HyperWidget/ 就能在桌面上跑。
 *
 *  三档布局都写了，切换右上角的 2×2 / 4×2 / 4×4 看效果。
 * ============================================================================
 */
const NAME = "设计工具演示";
const DESCRIPTION = "演示容器/文本/图标/进度/图表/图片/时钟的全部写法（可直接改成你自己的）";
const VERSION = "1.0.0";
const AUTHOR = "HyperWidget";
const SIZES = ["2x2", "4x2", "4x4"];

/* 脚本参数：在右下「变量」面板里填值，等价于桌面上的「编辑小组件」 */
const PRESETS = {
  greeting: { title: "问候语", default: "下午好" },
  showBars: { title: "显示柱状图", type: "switch", default: true },
};

/* 全局变量：所有脚本共用（同一份值），这里演示 ctx.global */
const GLOBALS = {
  city: { title: "城市", default: "北京" },
};

function render(ctx) {
  const size = ctx.size();
  const cls = ctx.sizeClass();
  const bat = ctx.battery();
  const now = ctx.time("HH:mm");
  const hello = ctx.env("greeting", "你好");
  const city = ctx.global("city", "—");
  const showBars = ctx.env("showBars", "true") === "true";

  // ctx.log 的输出在右下「控制台」面板里（设备上进 logcat / 框架日志）
  ctx.log("render 被调用：档位=" + cls + " 画布=" + size.w + "×" + size.h + "dp 电量=" + bat.level + "%");

  const batteryColor = bat.level <= 20 ? "accent" : "primary";

  /* ---------------------------------------------------------------- 2×2 */
  if (cls === "2x2") {
    return {
      refresh: 60,
      tap: "refresh",
      layout: ui.column([
        ui.titleBar({ icon: "bolt", title: NAME, size: 12, iconSize: 13, tap: "config" }),
        ui.spacer(0, 2),
        ui.iconStat({
          icon: bat.charging ? "bolt" : "battery",
          value: bat.level + "%",
          label: bat.charging ? "充电中 · " + bat.powerW.toFixed(1) + "W" : "剩余电量",
          size: 22,
          iconSize: 15,
          color: batteryColor,
        }),
        ui.spacer(0, 2),
        ui.progress(bat.level, 100),
        ui.spacer(0, 2),
        // stack 是"叠放"：底 + 字两层自己叠（两个子项都得给固定尺寸，见手册 §5 的 ui.stack 说明）
        ui.stack([
          ui.box([], { w: 60, h: 15, bg: "surface", radius: 8 }),
          ui.text(now, { w: 60, h: 15, align: "center", size: 11 }),
        ], { w: "wrap", h: 15 }),
      ], { gap: 4, w: "match", h: "match", gravity: "center" }),
    };
  }

  /* ---------------------------------------------------------------- 4×2 */
  if (cls === "4x2") {
    return {
      refresh: 60,
      tap: "refresh",
      layout: ui.column([
        ui.titleBar({
          icon: "sun",
          title: NAME,
          trailing: hello + " · " + city,
          size: 13,
        }),
        ui.spacer(0, 4),
        ui.row([
          ui.column([
            ui.bigNumber(bat.level, { unit: "%", size: 30, color: batteryColor }),
            ui.label(bat.charging ? "充电中 " + bat.powerW.toFixed(1) + "W" : "放电中 " + bat.currentMa + "mA"),
          ], { gap: 2, gravity: "left" }),
          ui.spacer(0, 0),
          ui.column([
            ui.kvRow("温度", bat.tempC.toFixed(1) + "℃", { size: 12 }),
            ui.kvRow("电压", bat.voltageV.toFixed(2) + "V", { size: 12 }),
          ], { gap: 3, w: "match" }),
        ], { gap: 10, w: "match", gravity: "center_vertical" }),
        ui.spacer(0, 6),
        ui.progress(bat.level, 100),
        ui.spacer(0, 6),
        ui.row([
          ui.chip("chip 组件", {}),
          ui.spacer(8, 0),
          ui.text("组合组件（chip / kvRows / gauge…）都能这样混搭", { size: 11, color: "secondary", w: "match", align: "end" }),
        ], { gap: 6, w: "match", gravity: "center_vertical" }),
      ], { gap: 0, w: "match", h: "match" }),
    };
  }

  /* ---------------------------------------------------------------- 4×4 */
  return {
    refresh: 60,
    tap: "refresh",
    layout: ui.column([
      ui.titleBar({
        icon: "star",
        title: NAME,
        trailing: hello + " · " + city,
        size: 14,
        iconSize: 16,
      }),
      ui.spacer(0, 6),

      // 大时钟（clock 节点由系统自己走字，不需要脚本刷新）
      ui.row([
        ui.clock({ format: "HH:mm", size: 30, color: "primary" }),
        ui.spacer(6, 0),
        ui.clock({ format: "ss", size: 14, color: "secondary" }),
        ui.text("时钟由系统走字 · 不需要脚本刷新", { size: 11, color: "secondary", w: "match", align: "end" }),
      ], { gap: 6, w: "match", gravity: "center_vertical" }),
      ui.spacer(0, 6),

      // ⚠️ box/stack 是 FrameLayout 语义（子项叠在左上角），card 也一样：
      // 想让多块内容上下排，必须自己包一层 column。直接写 ui.card([a, b, c]) 真机上会叠在一起。
      ui.card([
        ui.column([
          ui.gauge({
            value: bat.level,
            max: 100,
            label: "电池",
            text: bat.level + "%" + (bat.charging ? "（充电中）" : ""),
            color: batteryColor,
          }),
          ui.spacer(0, 8),
          ui.statRow([
            { value: bat.tempC.toFixed(1) + "℃", label: "温度" },
            { value: bat.voltageV.toFixed(2) + "V", label: "电压" },
            { value: bat.currentMa + "mA", label: "电流" },
          ], { size: 16, labelSize: 11 }),
        ], { gap: 0, w: "match" }),
      ], { padding: 10, radius: 14 }),
      ui.spacer(0, 6),

      // 在线图 / 本地图：image 节点的四种来源（path / res / b64 / url）
      ui.row([
        ui.image("mascot", { w: 40, h: 40 }),
        ui.spacer(8, 0),
        ui.column([
          ui.text("image 节点 · res 内置图", { size: 12, bold: true }),
          ui.label("脚本资源用 path：ui.image(\"图标.png\")"),
        ], { gap: 2, w: "match" }),
      ], { gap: 8, w: "match", gravity: "center_vertical" }),
      ui.spacer(0, 6),

      // 柱状图（值来自电池读数，纯演示结构）
      showBars ? ui.barChart({
        values: [bat.level, Math.abs(bat.currentMa) / 10, bat.tempC, bat.voltageV * 10, 60],
        labels: ["电量", "电流", "温度", "电压", "基准"],
        max: 100,
        height: 32,
        barWidth: 18,
        gap: 8,
        bg: "accent",
      }) : ui.label("柱状图已在「变量」面板里关掉（showBars）"),

      // 4×4 画布只有 335dp 可用（365 − 上下各 15dp 安全区），内容排不下就会被裁掉。
      // 工具右下角状态栏会显示画布尺寸，改完对着看一眼高度是否还留有余量。
      ui.spacer(0, 6),
      ui.grid(2, [
        ui.iconStat({ icon: "wifi", value: "已连接", label: "网络", size: 13, iconSize: 14 }),
        ui.iconStat({ icon: "moon", value: ctx.device().isDarkMode ? "深色" : "浅色", label: "主题", size: 13, iconSize: 14, iconColor: "secondary" }),
      ], { gap: 8, w: "match" }),
    ], { gap: 0, w: "match", h: "match" }),
  };
}
