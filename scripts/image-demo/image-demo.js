// ===== 小组件元数据（必填 NAME/DESCRIPTION/VERSION/AUTHOR）=====
const NAME = "图片卡片示例";
const DESCRIPTION = "演示静态资源：image 节点的 path 指向 assets/ 文件夹";
const VERSION = "1.0.0";
const AUTHOR = "澎湃组件";
const SIZES = ["2x2", "4x2", "4x4"];

// 脚本参数：应用「变量」页里可以改，ctx.env(key) 读取
const PRESETS = {
  caption: { title: "副标题", default: "资源随脚本一起安装" }
};

// 这个脚本演示市场脚本的静态资源约定：
// 资源放在脚本大文件夹的 assets/ 下，安装后会原样落到
// Download/HyperWidget/image-demo/assets/，所以脚本里直接写 path: "assets/…"，
// 仓库里的目录结构和设备上完全一致（含子目录 assets/icons/）。
function render(ctx) {
  var b = ctx.battery();
  var caption = ctx.env("caption", "资源随脚本一起安装");
  var logo = { path: "assets/logo.png" };
  var badge = { path: "assets/icons/badge.png" };

  // 2×2：图标 + 名称 + 副标题
  if (ctx.sizeClass() === "2x2") {
    return { refresh: 60, tap: "config", layout: ui.column([
      ui.image(logo, { w: 72, h: 72 }),
      ui.text(NAME, { size: 13, bold: true, color: "primary", align: "center", w: "match" }),
      ui.text(caption, { size: 10, color: "secondary", align: "center", w: "match", maxLines: 2 })
    ], { gap: 4, h: "match", gravity: "center" }) };
  }

  // 4×2：标题栏 + 左图右文
  if (ctx.sizeClass() === "4x2") {
    return { refresh: 60, tap: "config", layout: ui.column([
      ui.titleBar({ icon: "star", title: NAME, trailing: b.level + "%" }),
      ui.row([
        ui.image(logo, { w: 84, h: 84 }),
        ui.column([
          ui.text(caption, { size: 12, color: "primary", maxLines: 2 }),
          ui.text("path: assets/logo.png", { size: 10, color: "secondary", maxLines: 1 })
        ], { w: "match", gap: 4, gravity: "center" })
      ], { gap: 12 })
    ], { gap: 10 }) };
  }

  // 4×4：大图 + 子目录里的角标 + 资源说明
  return { refresh: 60, tap: "config", layout: ui.column([
    ui.titleBar({ icon: "star", title: NAME, trailing: "v" + VERSION }),
    ui.column([ui.image(logo, { w: 118, h: 118 })], { w: "match", gravity: "center" }),
    ui.text(caption, { size: 12, color: "secondary", align: "center", w: "match", maxLines: 1 }),
    ui.divider(),
    ui.kvRows([
      ["主图", "assets/logo.png"],
      ["角标", "assets/icons/badge.png"],
      ["电量", b.level + "% · " + (b.charging ? "充电中" : "放电中")]
    ]),
    ui.row([
      ui.image(badge, { w: 22, h: 22 }),
      ui.text("assets/ 子目录里的图片也会随脚本一起安装", { size: 11, color: "secondary", w: "match", maxLines: 1 })
    ], { gap: 8 })
  ], { gap: 8, h: "match", gravity: "center" }) };
}
