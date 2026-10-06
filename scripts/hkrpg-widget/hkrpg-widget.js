/* ============================================================================
 *  崩坏：星穹铁道 · 官方小组件复刻（4×2 / 4×4）  · 通用脚本（不含账号信息）
 *  ---------------------------------------------------------------------------
 *  数据与官方「崩坏：星穹铁道」桌面小部件同源：
 *    GET /game_record/hkrpg/game/get_act_calender_widget?role_id=&server=
 *  展示：开拓力（含自动推算回满时间）、每日实训 / 周期积分 / 活动进度与剩余天数、
 *        当期跃迁（卡池）角色与剩余天数、当期挑战（末日幻影等）进度、米游社签到状态。
 *
 *  两处尺寸差异：4×2 顶部右侧是签到状态；4×4 顶部右上角是签到状态（左侧是「换背景」），
 *  活动行下面多一行当期挑战，底部不再放「刷新 / 启动游戏」——整卡点击就是刷新。
 *
 *  ⚠️ 本脚本**不含任何账号信息**（通用）：Cookie / 角色 ID / 服务器都在应用「变量」页里填，
 *     脚本只从 ctx.env 读。Cookie 是登录凭据，别写进脚本文件、别分享给你不信任的人。
 *
 *  说明：
 *    · 单文件同时负责 4×2 与 4×4 两个尺寸（按 ctx.sizeClass() 分支），不用装两份；
 *    · 桌面曝光刷新很频繁（15s 级），脚本内部按 MIN_FETCH_SEC 节流：
 *      窗口内直接用缓存快照渲染，并**按 6 分钟/点本地推算开拓力**，不发网络请求；
 *    · 快照存在实例级存储里（ctx.storeGet），离线时渲染上一次的数据，不会变错误卡片；
 *    · 静态资源（背景 / 体力图标 / logo）来自 Download/HyperWidget/崩坏星穹铁道/，
 *      角色头像与活动图标走接口 URL（ctx.httpBinary 按脚本落盘缓存，只下载一次）。
 * ========================================================================== */

/* ===== 元数据（规范 v1） ===== */
const NAME = "崩坏：星穹铁道";
const DESCRIPTION = "开拓力 / 每日实训 / 活动剩余时间（官方小组件复刻）";
const VERSION = "1.1.0";
const AUTHOR = "lswlc";
const MIN_ENGINE = "1.1";
const UPDATED_AT = "2026-10-05 21:37"
const SIZES = ["4x2", "4x4"];

/* ===== 脚本参数（应用「变量」页 / 原生「编辑小组件 → 变量」里填） ===== */
const PRESETS = {
  cookie: {
    title: "米游社 Cookie"
  },
  roleId: {
    title: "角色 ID（role_id）"
  },
  server: {
    title: "服务器（国服填 prod_gf_cn）"
  },
  bg: {
    title: "4×4 背景（角色名或 ID，留空=默认全员图）"
  }
};

/* ===== 常量 ===== */
var API = "https://api-takumi-record.mihoyo.com/game_record/hkrpg/game/get_act_calender_widget";
var API_BG_LIST = "https://api-takumi-record.mihoyo.com/game_record/hkrpg/game/get_widget_avatar_list";
var BG_LIST_TTL_MS = 86400000;   // 背景列表（角色卡面）一天拉一次就够
var BG_NEXT_TAP = "url:hyperwidget://widget-action?action=next-bg";   // 点一下换背景的深链
var BG_KEY = "hkrpgBgIndex";     // 背景选择存**全局变量**：所有实例 + 编辑器预览共用一份
var TITLE = "崩坏：星穹铁道";
var REFRESH_SEC = 900;        // 桌面闹钟刷新间隔（秒）
var MIN_FETCH_SEC = 600;      // 两次真实请求的最小间隔（秒），曝光刷新很频繁，必须节流
var STAMINA_SEC_PER_POINT = 360;  // 开拓力恢复速度：6 分钟 1 点
var ROWS_4X2 = 4;             // 4×2 右侧列表行数
var ROWS_4X4 = 4;             // 4×4 活动行数（当期挑战另占一行，见 layout4x4）
var SNAP_V = 2;               // 快照结构版本：字段变更时 +1，旧快照立即重取（不等节流窗口）
var BG_ART = "assets/bg_art.webp";    // 4×4 默认背景画稿（应用侧按主题合成面板与过渡）
var ICON_STAMINA = "assets/icon_stamina.png";
var ICON_LOGO = "assets/icon_logo.png";

/* ===== 小工具 ===== */
function pad2(n) { return (n < 10 ? "0" : "") + n; }

function nz(v) { return v === undefined || v === null ? "" : String(v); }

/* 接口里大量字段是 [{content, is_highlight}] 分段文本，拼成整串 */
function segText(segs) {
  var s = "";
  if (!segs) return s;
  for (var i = 0; i < segs.length; i++) s += nz(segs[i].content);
  return s;
}

/* 分段文本 → 分色片段：相邻同色合并，用于「0/18000 里 0 高亮」这类样式 */
function runs(segs) {
  var out = [];
  if (!segs) return out;
  for (var i = 0; i < segs.length; i++) {
    var t = nz(segs[i].content);
    if (!t) continue;
    var hi = segs[i].is_highlight === true;
    if (out.length && out[out.length - 1].hi === hi) out[out.length - 1].t += t;
    else out.push({ t: t, hi: hi });
  }
  return out;
}

/* 中文按 1em、拉丁/数字按 0.55em 估宽，超宽截断加省略号（RemoteViews 里没法量文本） */
function fitText(t, availDp, sizeSp) {
  var w = 0, n = 0;
  for (var i = 0; i < t.length; i++) {
    var cw = (t.charCodeAt(i) < 128 ? 0.55 : 1.0) * sizeSp;
    if (w + cw > availDp) {
      // 省略号自己也要占一个字宽，否则「截断后的标题」比预算还宽，
      // 会把行尾的值挤成 0 宽（真机上「未完成」被挤成「未…」）
      return t.substring(0, Math.max(0, n - 1)) + "…";
    }
    w += cw; n++;
  }
  return t;
}

function textWidth(t, sizeSp) {
  var w = 0;
  for (var i = 0; i < t.length; i++) w += (t.charCodeAt(i) < 128 ? 0.55 : 1.0) * sizeSp;
  return w;
}

/* 「明天04:45回满」：按回满时刻落在今天/明天/后天选择措辞 */
function recoverText(leftSec, nowMs) {
  if (leftSec <= 0) return "已回满";
  var at = new Date(nowMs + leftSec * 1000);
  var now = new Date(nowMs);
  var d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  var d1 = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  var diff = Math.round((d1 - d0) / 86400000);
  var word = diff <= 0 ? "今天" : (diff === 1 ? "明天" : (diff === 2 ? "后天" : diff + "天后"));
  return word + pad2(at.getHours()) + ":" + pad2(at.getMinutes()) + "回满";
}

/* 头像/活动图标：下载失败只丢这一张图，不让整卡渲染失败 */
function imgB64(ctx, url) {
  if (!url) return null;
  try {
    return ctx.httpBinary(url);
  } catch (e) {
    ctx.log("图标下载失败 " + url + ": " + e);
    return null;
  }
}

/* 米游社签到状态（activity_calendar_v2.sign_info.has_signed）：
   接口没给这个字段时返回 null——宁可不显示，也不要误报「未签到」 */
function signLabel(snap) {
  if (snap.sign === true) return { t: "已签到", color: "secondary" };
  if (snap.sign === false) return { t: "未签到", color: "accent" };
  return null;
}

/* 挑战结束日期："2026-11-16 04:00:00" → "11-16" */
function endDate(s) {
  var m = /^\d{4}-(\d{2}-\d{2})/.exec(String(s || ""));
  return m ? m[1] : "";
}

/* 分段进度拼回整串（[{t:"0"},{t:"/500"}] → "0/500"） */
function joinRuns(rs) {
  var t = "";
  for (var i = 0; i < (rs ? rs.length : 0); i++) t += rs[i].t;
  return t;
}

/* ===== 取数 ===== */
function fetchSnapshot(ctx, cookie, roleId, server) {
  var res = ctx.http({
    url: API + "?role_id=" + encodeURIComponent(roleId) + "&server=" + encodeURIComponent(server),
    method: "GET",
    headers: {
      "User-Agent": "okhttp/4.10.0",
      "Connection": "Keep-Alive",
      "x-rpc-language": "zh-cn",
      "Cookie": cookie
    }
  });
  if (!res.ok) throw new Error("接口 HTTP " + res.status + "（Cookie 是否失效？）");

  var d = ctx.json(res.body);
  if (!d || d.retcode !== 0) {
    var code = d ? d.retcode : "?";
    var msg = d && d.message ? d.message : "";
    throw new Error("接口返回 " + code + (msg ? "（" + msg + "）" : "") +
      (code === -100 || code === 10001 ? "，Cookie 已失效" : ""));
  }

  var data = d.data || {};
  var bi = data.base_info || {};
  var cal = data.activity_calendar_v2 || {};

  var banners = [];
  var pools = cal.card_pool_list || [];
  for (var i = 0; i < pools.length && banners.length < 2; i++) {
    var av = pools[i].avatar_list && pools[i].avatar_list.length ? pools[i].avatar_list[0] : null;
    banners.push({ days: segText(pools[i].title), icon: av ? nz(av.icon_url) : "" });
  }

  var acts = [];
  var list = cal.activity_list || [];
  for (var j = 0; j < list.length; j++) {
    acts.push({
      title: segText(list[j].title),
      runs: runs(list[j].progress),
      days: segText(list[j].count_down),
      icon: nz(list[j].dark_icon || list[j].icon)
    });
  }

  /* 米游社签到状态 + 当期挑战（末日幻影 / 虚构叙事 / 忘却之庭，取挑战列表第一项） */
  var si = cal.sign_info || {};
  var sign = typeof si.has_signed === "boolean" ? si.has_signed : null;

  var chs = data.challenges || [];
  var ch = null;
  for (var c = 0; c < chs.length; c++) {
    if (!chs[c] || !chs[c].name_mi18n) continue;
    if (!ch) ch = chs[c];
    if (chs[c].status === "challengeStatusInProgress") { ch = chs[c]; break; }
  }
  var cti = ch && ch.time_info ? ch.time_info : {};
  var challenge = ch ? {
    name: nz(ch.name_mi18n),
    text: nz(ch.show_text),
    end: endDate(cti.end_time),
    icon: nz(ch.special_reward ? ch.special_reward.icon : "")
  } : null;

  return {
    v: SNAP_V,
    ts: new Date().getTime(),
    stamina: Number(bi.current_stamina || 0),
    max: Number(bi.max_stamina || 0),
    recover: Number(bi.stamina_recover_time || 0),
    reserve: Number(bi.current_reserve_stamina || 0),
    sign: sign,
    challenge: challenge,
    banners: banners,
    acts: acts
  };
}

/* ===== 4×4 背景：官方角色卡面列表 + 当前选择 ===== */

/* 拉取背景（角色卡面）列表；一天一次，失败沿用缓存 */
function ensureBgList(ctx, cookie) {
  var now = new Date().getTime();
  var at = parseInt(ctx.storeGet("bgsAt") || "0", 10) || 0;
  var cached = null;
  try {
    var raw = ctx.storeGet("bgs");
    if (raw) cached = ctx.json(raw);
  } catch (e) {
    cached = null;
  }
  if (cached && (now - at) < BG_LIST_TTL_MS) return cached;

  try {
    var res = ctx.http({
      url: API_BG_LIST,
      method: "GET",
      headers: {
        "User-Agent": "okhttp/4.10.0",
        "x-rpc-language": "zh-cn",
        "Cookie": cookie
      }
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    var d = ctx.json(res.body);
    var raw = (d && d.data && d.data.avatar_list) || [];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var a = raw[i];
      if (!a || !a.background_pic) continue;
      out.push({ id: nz(a.item_id), name: nz(a.item_name), pic: nz(a.background_pic) });
    }
    if (out.length) {
      ctx.storeSet("bgs", JSON.stringify(out));
      ctx.storeSet("bgsAt", String(now));
      return out;
    }
  } catch (e) {
    ctx.log("背景列表获取失败: " + e);
  }
  return cached || [];
}

/* 当前背景：索引 0 = 内置全员画稿，1..N = 列表里的角色（点「换背景」按这个顺序循环） */
function pickBg(ctx, list, wantName) {
  // 全局键（桌面/预览/多实例共用）；读不到再回落到旧版按实例存的值
  var idx = parseInt(ctx.global(BG_KEY, "") || "", 10);
  if (isNaN(idx)) idx = parseInt(ctx.storeGet("bgIndex") || "0", 10) || 0;
  var want = (wantName || "").replace(/^\s+|\s+$/g, "");
  if (want && list.length) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === want || list[i].name === want || list[i].name.indexOf(want) >= 0) {
        idx = i + 1;
        break;
      }
    }
  }
  if (idx < 0 || idx > list.length) idx = 0;
  if (idx === 0) return { idx: 0, name: "默认", pic: "" };
  return { idx: idx, name: list[idx - 1].name, pic: list[idx - 1].pic };
}

/* ===== 快照读写（实例级存储） ===== */
function loadSnap(ctx) {
  try {
    var raw = ctx.storeGet("snap");
    return raw ? ctx.json(raw) : null;
  } catch (e) {
    return null;
  }
}

function saveSnap(ctx, snap) {
  try {
    ctx.storeSet("snap", JSON.stringify(snap));
  } catch (e) {
    ctx.log("快照写入失败: " + e);
  }
}

/* 按快照时间本地推算当前开拓力（6 分钟 1 点），两次取数之间也能显示实时值 */
function project(snap, nowMs) {
  var elapsed = Math.max(0, (nowMs - snap.ts) / 1000);
  var cur = snap.stamina;
  if (snap.max > 0 && snap.recover > 0) {
    cur = Math.min(snap.max, snap.stamina + Math.floor(elapsed / STAMINA_SEC_PER_POINT));
  }
  return { cur: cur, left: Math.max(0, snap.recover - elapsed) };
}

/* ============================================================================
 *  布局
 * ========================================================================== */

/* 头像：矩形小图。
   官方是圆形头像，但引擎侧没有可靠的图片圆角裁剪——box 的 radius /
   clipToOutline 在 RemoteViews 里不生效（预览与真机都实测过），所以用直角色块。 */
function avatar(b64, size) {
  if (!b64) return null;
  return ui.image({ b64: b64, w: size, h: size });
}

/* 未取到数据时的说明卡 */
function errorSpec(reason) {
  return {
    refresh: 120,
    tap: "refresh",
    layout: ui.column([
      ui.titleBar({ icon: "bolt", title: TITLE, trailing: "离线" }),
      ui.text("未获取到数据", { size: 14, bold: true }),
      ui.text(reason, { size: 11, color: "secondary", maxLines: 3 }),
      ui.label("点一下重试；Cookie 过期请在「变量」页更新", { maxLines: 2 })
    ], { gap: 6, h: "match", gravity: "center" })
  };
}

/* ---------------- 4×2：左体力卡 + 右任务列表 ---------------- */
function layout4x2(ctx, snap) {
  var s = ctx.size();
  // 根模板自带 15dp 安全区内边距；桌面**实际画布比 options 上报值小一圈**
  // （本机 4×4 实测上报 350×365、真机量到约 341×344），所以再打 96% / 93% 的余量，
  // 并让整块内容在画布里居中——写满上报值会被裁掉右侧和底部。
  var cw = Math.round((s.w - 30) * 0.96);
  var Hc = Math.round((s.h - 30) * 0.93);
  var gap = 6;
  var headH = 20;
  var bodyH = Math.max(60, Hc - headH - gap);
  var leftW = Math.round(cw * 0.36);
  var rightW = cw - leftW - gap;
  var pad = 7;
  var nowMs = new Date().getTime();

  var p = project(snap, nowMs);

  /* 左卡：体力 + 当期跃迁剩余天数。
     注意 box 是 FrameLayout（子项会叠在一起），里面必须放一个 column 才竖排；
     深度预算紧（根 column → row → box → column → row → 叶子 正好 6 层），
     所以「196/300」用三个并排叶子节点，不再套内层 column。 */
  var stH = 30;
  var avSize = Math.max(20, Math.min(30, bodyH - pad * 2 - stH - 11 - 3 - 11 - 3 - 3));
  var labelW = 38;                         // 「剩余16天」≈ 4 字 × 9.5sp，仅用于头像行对齐

  var leftKids = [ui.row([
    ui.image({ path: ICON_STAMINA, w: stH, h: stH }),
    ui.text(String(p.cur), { size: 18, bold: true }),
    ui.text("/" + snap.max, { size: 10, color: "secondary" })
  ], { gap: 4, h: stH, gravity: "center" })];

  leftKids.push(ui.text(recoverText(p.left, nowMs), { size: 9.5, color: "secondary" }));

  var bTexts = [], bIcons = [];
  for (var i = 0; i < snap.banners.length && i < 2; i++) {
    var b = snap.banners[i];
    bTexts.push(ui.text(b.days, { size: 9.5 }));
    var ico = imgB64(ctx, b.icon);
    // 4×2 里嵌不下圆角裁剪的 box（深度上限 6），这里用直角小图
    if (ico) bIcons.push(ui.image({ b64: ico, w: avSize, h: avSize }));
  }
  if (bTexts.length) leftKids.push(ui.row(bTexts, { gap: 12, gravity: "center_horizontal" }));
  if (bIcons.length) {
    // 头像行比文字行窄，gap 补偿一下让两者中心对齐
    leftKids.push(ui.row(bIcons, {
      gap: Math.max(4, labelW + 12 - avSize), gravity: "center_horizontal"
    }));
  }

  var left = ui.box([ui.column(leftKids, {
    gap: 3, h: bodyH - pad * 2, gravity: "center"
  })], { w: leftW, h: bodyH, bg: "surface", radius: 12, padding: pad });

  /* 右卡：活动列表（图标 + 名称 + 进度）。
     进度按接口的 is_highlight 分两色（当前值 accent、上限 primary）。
     右对齐：RemoteViews 没有权重，行尾 w:"match" 只能给**最后一个**节点，
     所以先在值前面插一个按估算宽度算出来的 spacer 把值推到右边（估算偏小时
     由行尾 match 吸收，绝不会把值挤出右边界）。 */
  var rows = [];
  var innerW = rightW - pad * 2;
  var rowGap = 4;
  var shown = Math.min(snap.acts.length, ROWS_4X2);
  var rowH = Math.floor((bodyH - pad * 2 - (shown > 1 ? shown - 1 : 0)) / Math.max(1, shown));
  for (var k = 0; k < shown; k++) {
    if (k > 0) rows.push(ui.divider());
    var a = snap.acts[k];
    var aico = imgB64(ctx, a.icon);
    var vruns = a.runs && a.runs.length ? a.runs : [{ t: "--", hi: false }];
    var valW = 0;
    for (var m = 0; m < vruns.length; m++) valW += textWidth(vruns[m].t, 11);
    var leading = aico ? 14 : 0;
    var gaps = (aico ? 1 : 0) + vruns.length + 1;      // icon/标题/spacer/各值片段之间的空隙数
    var title = fitText(a.title, innerW - leading - valW - rowGap * gaps - 2, 11);

    var kids = [];
    if (aico) kids.push(ui.image({ b64: aico, w: 13, h: 13 }));
    kids.push(ui.text(title, { size: 11 }));
    kids.push(ui.spacer(Math.max(2,
      innerW - leading - textWidth(title, 11) - valW - rowGap * gaps - 2), 1));
    for (var n = 0; n < vruns.length; n++) {
      var lastRun = n === vruns.length - 1;
      kids.push(ui.text(vruns[n].t, {
        size: 11,
        color: vruns[n].hi ? "accent" : "primary",
        w: lastRun ? "match" : undefined,
        align: lastRun ? "end" : undefined
      }));
    }
    rows.push(ui.row(kids, { gap: rowGap, h: rowH, gravity: "center" }));
  }

  var right = ui.box([ui.column(rows, {
    gap: 0, h: bodyH - pad * 2, gravity: "center"
  })], { w: "match", h: bodyH, bg: "surface", radius: 12, padding: pad });

  /* 头部：logo + 标题 + 右上角签到状态。
     原来的「刷新 | 启动游戏」两个文字按钮去掉了——整卡点击就是刷新，
     桌面场景没人点「启动游戏」，位置让给每次都会看的签到状态。 */
  var headerKids = [
    ui.image({ path: ICON_LOGO, w: 15, h: 15 }),
    ui.text(TITLE, { size: 13, bold: true, maxLines: 1 })
  ];
  var sg = signLabel(snap);
  // 行尾 w:"match" + align:"end"：把签到状态推到最右（match 只能写在行尾，见 LayoutNode）
  if (sg) headerKids.push(ui.text(sg.t, { size: 11, color: sg.color, w: "match", align: "end" }));
  var header = ui.row(headerKids, { gap: 6, h: headH, w: cw, gravity: "center" });

  return ui.column([header, ui.row([left, right], { gap: gap, h: bodyH, w: cw })],
    { gap: gap, h: "match", w: "match", gravity: "center" });
}

/* ---------------- 4×4：出血卡片（画稿铺满 + 底部面板） ---------------- */
function layout4x4(ctx, snap, bg) {
  var s = ctx.size();
  // 4×4 是**出血**卡片（render 里返回 bleed: true，根模板没有 15dp 安全区）：
  // 背景是一整张由应用进程合成好的图（画稿裁切 + 过渡 + 面板 + 圆角），走 content://
  // 交给宿主自己解码——全分辨率，不进 binder。
  // 文字块仍按上报值打折估真实画布（本机实测上报 350×365 → 真实约 341×344）。
  var isPreview = false;
  try { isPreview = ctx.meta().isPreview === true; } catch (e) { isPreview = false; }
  // 预览画布 = 上报值原样；桌面的真实画布比上报值小一圈（本机 350×365 → 341×344），
  // 所以只在桌面打折。两边都按同一套比例排，预览看起来才和桌面对得上。
  var estW = isPreview ? s.w : Math.round(s.w * 0.975);
  var estH = isPreview ? s.h : Math.round(s.h * 0.935);
  // 官方那张卡：面板本身是左右各内缩 ~17dp 的圆角浮层，正文再在面板里缩进 ~15dp，
  // 所以正文离小组件边缘约 32dp——通铺满宽 + 只缩 21dp 看着就是「贴边」。
  var panelInset = 16;                             // 面板左右/下边内缩
  var rowPad = 14;                                 // 正文在面板内再缩进
  var cw = estW - (panelInset + rowPad) * 2;       // 正文宽（左右各留 panelInset+rowPad）
  var rowH = 46;                                   // 体力行高
  var chipH = 22;
  var topPad = 28;                                 // 顶部按钮行上下留白（16+28 → 按钮离上沿 14dp）
  var padIn = 12;                                  // 面板内容上下边距（第一行/最后一行都留）
  var wantTaskH = 30, minTaskH = 21;               // 单行理想/最小高度

  var nowMs = new Date().getTime();
  var p = project(snap, nowMs);

  /* 「换背景」按钮：点一下切下一张（深链改实例 store 再刷新，见 WidgetActionActivity） */
  var nextTap = BG_NEXT_TAP + "&widget=" + ctx.meta().widgetId +
    "&key=" + BG_KEY + "&scope=global&legacy=bgIndex&count=" + (snap.bgList.length + 1);
  var chip = ui.box([ui.text("换背景 · " + bg.name, { size: 10.5, maxLines: 1 })],
    { bg: "card", radius: 10, padding: 5, tap: nextTap });

  /* 体力 + 当期跃迁 */
  var stW = Math.round(cw * 0.25);          // 体力文字块宽度：必须显式给，否则「/300」会被挤成省略号
  var stKids = [
    ui.image({ path: ICON_STAMINA, w: 38, h: 38 }),
    ui.column([
      ui.row([
        ui.text(String(p.cur), { size: 23, bold: true }),
        ui.text("/" + snap.max, { size: 11.5, color: "secondary" })
      ], { gap: 2 }),
      ui.text(recoverText(p.left, nowMs), { size: 10.5, color: "secondary" })
    ], { w: stW, gap: 1 })
  ];
  var banKids = [];
  for (var i = 0; i < snap.banners.length && i < 2; i++) {
    var b = snap.banners[i];
    var c = avatar(imgB64(ctx, b.icon), 26);
    if (c) banKids.push(c);
    banKids.push(ui.text(b.days, { size: 10.5 }));
  }
  if (banKids.length) stKids.push(ui.row(banKids, { w: "match", gap: 8, gravity: "end" }));
  var staminaRow = ui.row(stKids, { h: rowH, w: cw, gap: 6, gravity: "center" });

  /* 行定义：活动行 + 当期挑战行（接口 challenges[] 第一项）。
     底部原来的「刷新 / 启动游戏」去掉了（整卡点击就是刷新），省下的高度正好放挑战行。 */
  var defs = [];
  for (var k = 0; k < snap.acts.length && k < ROWS_4X4; k++) {
    defs.push({
      icon: snap.acts[k].icon,
      title: snap.acts[k].title,
      sub: snap.acts[k].days,
      val: joinRuns(snap.acts[k].runs)
    });
  }
  if (snap.challenge) {
    defs.push({
      icon: snap.challenge.icon,
      title: snap.challenge.name,
      sub: snap.challenge.end ? snap.challenge.end + "结束" : "",
      val: snap.challenge.text
    });
  }
  /* 垂直分配：先按行数算出面板想要多高（行 + 上下边距），画稿区让出空间但不少于 45%；
     再按实际能用的高度定单行高度（理想 30dp，最小 21dp）。
     这样加/减活动行时，面板内容始终**上下等距**，也不会把最后一行顶到画布外。 */
  var wantPanel = defs.length * wantTaskH + padIn * 2;
  var artH = Math.max(Math.round(estH * 0.45), estH - wantPanel);   // 画稿/面板分界（与合成图一致）
  var panelH = estH - artH;
  var taskH = Math.max(minTaskH, Math.min(wantTaskH,
    Math.floor(((estH - padIn) - (artH + padIn)) / Math.max(1, defs.length))));

  /* 背景：宽高都比估计值多留一点（居中、溢出被裁），避免真实画布略大时露边；
     panel=画稿区高度（面板顶边），round=可见底边（圆角画在这），再往下是兜底溢出区。 */
  var bgW = estW + 10;
  var bgH = estH + 30;
  var fadeH = Math.min(52, Math.round(panelH * 0.35));
  // round 取比估计底边再低一点：圆角落在真实底边附近（估计值比真实画布矮几个 dp），
  // 太高会在面板中间露出一圈圆角，太低则圆角被裁掉变直角
  var bgProps = { w: bgW, h: bgH, paneltop: artH, round: estH + 8, fade: fadeH,
                  corner: 18, panelinset: panelInset };
  var bgImage = bg.pic
    ? ui.image({ url: bg.pic, uri: true, w: bgProps.w, h: bgProps.h,
                 paneltop: bgProps.paneltop, round: bgProps.round, fade: bgProps.fade,
                 corner: bgProps.corner, panelinset: bgProps.panelinset })
    : ui.image({ file: BG_ART, w: bgProps.w, h: bgProps.h,
                 paneltop: bgProps.paneltop, round: bgProps.round, fade: bgProps.fade,
                 corner: bgProps.corner, panelinset: bgProps.panelinset });

  /* 活动行：图标 + 名称 +（剩余天数）+ 右侧进度胶囊 */
  var tasks = [];
  for (var d = 0; d < defs.length; d++) {
    var kids = [];
    var dico = imgB64(ctx, defs[d].icon);
    if (dico) kids.push(ui.image({ b64: dico, w: 19, h: 19 }));
    kids.push(ui.text(defs[d].title, { size: 13.5, maxLines: 1 }));
    if (defs[d].sub) kids.push(ui.text(defs[d].sub, { size: 10.5, color: "secondary", maxLines: 1 }));
    if (defs[d].val) {
      kids.push(ui.row([
        ui.box([ui.text(defs[d].val, { size: 11.5 })], { bg: "surface", radius: 10, padding: 4 })
      ], { w: "match", gravity: "end" }));
    }
    tasks.push(ui.row(kids, { gap: 6, h: taskH, w: cw, gravity: "center" }));
  }

  /* 顶部一行：左「换背景」、右签到状态。
     两个都压在画稿上，各自带 chip 底保证可读；右对齐不用 w:"match"（FrameLayout 里
     的 match 不生效），沿用 4×2 那套「按估算宽度补一个 spacer」的写法。 */
  var sg = signLabel(snap);
  var chipW = Math.round(textWidth("换背景 · " + bg.name, 10.5)) + 10;
  var signW = sg ? Math.round(textWidth(sg.t, 10.5)) + 10 : 0;
  // 顶部行比正文行宽 16dp：按钮左右各比正文外扩 8dp，与 14dp 的上下留白视觉对称
  var topRowW = estW - 24;                         // 顶部按钮行：离左右各 12dp
  var topKids = [chip];
  if (sg) {
    topKids.push(ui.spacer(Math.max(4, topRowW - chipW - signW), 1));
    topKids.push(ui.box([ui.text(sg.t, { size: 10.5, color: sg.color, maxLines: 1 })],
      { bg: "card", radius: 10, padding: 5 }));
  }

  var topRowH = chipH + topPad;
  var content = [
    ui.row(topKids, { h: topRowH, w: topRowW, gravity: "center" }),
    // 体力行压在画稿分界上方 4dp；再空 padIn+4 让第一行活动从面板顶边下方 padIn 处开始
    ui.spacer(cw, Math.max(0, artH - topRowH - rowH - 4)),
    staminaRow,
    ui.spacer(cw, padIn + 4)
  ].concat(tasks).concat([ui.spacer(cw, padIn)]);   // 末尾补下边距，与上边距对称

  return ui.stack([
    ui.column([bgImage], { w: "match", gravity: "center_horizontal" }),
    ui.column(content, { w: "match", h: "match", gravity: "center_horizontal" })
  ], { w: "match", h: "match" });
}

/* ============================================================================
 *  入口
 * ========================================================================== */
function render(ctx) {
  // 账号信息全部来自「变量」页（PRESETS 里没有 default，脚本文件保持通用）：
  // Cookie 与角色 ID 必填，服务器留空时用国服兜底值。
  var cookie = (ctx.env("cookie", "") || "").replace(/^\s+|\s+$/g, "");
  var roleId = (ctx.env("roleId", "") || "").replace(/^\s+|\s+$/g, "");
  var server = (ctx.env("server", "") || "").replace(/^\s+|\s+$/g, "") || "prod_gf_cn";

  if (!cookie) return errorSpec("还没有填「米游社 Cookie」（应用「变量」页）");
  if (!roleId) return errorSpec("还没有填「角色 ID（role_id）」（应用「变量」页）");

  var snap = loadSnap(ctx);
  var nowMs = new Date().getTime();
  var lastFetch = parseInt(ctx.storeGet("lastFetch") || "0", 10) || 0;
  // 快照结构版本不一致也立刻重取：否则升级后的前十分钟（节流窗口）会缺「签到 / 挑战」两项
  var needFetch = !snap || snap.v !== SNAP_V || (nowMs - lastFetch) >= MIN_FETCH_SEC * 1000;

  if (needFetch) {
    ctx.storeSet("lastFetch", String(nowMs));   // 先占位：失败也不要在曝光刷新里连打接口
    try {
      var fresh = fetchSnapshot(ctx, cookie, roleId, server);
      saveSnap(ctx, fresh);
      snap = fresh;
    } catch (e) {
      var msg = nz(e && e.message ? e.message : e);
      ctx.log("取数失败: " + msg);
      if (!snap) return errorSpec(msg);
    }
  }

  // 4×4 的背景列表（角色卡面）与当前选择；4×2 用不到，但也一并算好，逻辑简单
  snap.bgList = ensureBgList(ctx, cookie);
  var bgInfo = pickBg(ctx, snap.bgList, ctx.env("bg", ""));

  var isDark = true;
  try {
    isDark = ctx.device().isDarkMode !== false;
  } catch (e) {
    isDark = true;
  }

  var is4x4 = ctx.sizeClass() === "4x4";
  var layout = is4x4
    ? layout4x4(ctx, snap, bgInfo)
    : layout4x2(ctx, snap);

  // 4×4 走出血：官方那张卡是画稿铺满整块，不留安全区（4×2 是卡片式，保持默认留边）
  return { refresh: REFRESH_SEC, tap: "refresh", layout: layout, bleed: is4x4 };
}
