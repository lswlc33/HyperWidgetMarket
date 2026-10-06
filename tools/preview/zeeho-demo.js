/*
 * 预览用演示版（不是要上架的脚本）：/真机生成 preview/4x2-dark.png 时用。
 * 它把 apiRequest 换成返回假数据，避免市场截图里出现真实车辆信息。
 * 用法：推到设备 /sdcard/Download/HyperWidget/zeeho-demo.js，再用
 *   adb exec-out content read --uri "content://io.github.lswlc33.hyperwidget.preview/4x2?script=zeeho-demo.js"
 * 取图，替换 scripts/zeeho-scooter/preview/4x2-dark.png。
 */
/*
 * =========================================================
 *  ZEEHO 车辆小组件（春风动力 CFMOTO / ZEEHO 电动车）· 4×2
 * =========================================================
 *
 *  只做「信息获取与展示」，不执行任何任务操作：
 *    · 电量 / 剩余续航 / 充电状态
 *    · 胎压监测（前 / 后）
 *    · 今日（或最近一次）骑行里程与时长
 *    · 总积分
 *
 *  ⚠️ token 是账号登录凭据，只存在应用「变量」页里，不在脚本内、也不上传到任何地方；
 *     失效（小组件显示「Token 失效」）后重新抓包，在变量页更新即可。
 *
 *  说明：
 *    · 首次运行自动调「车辆列表」接口取第一辆车的 VIN 并缓存到实例存储；
 *    · 桌面曝光刷新很频繁（15s 级），脚本按 MIN_FETCH_SEC 节流：窗口内直接用缓存快照渲染；
 *    · 存储按实例（widgetId）隔离，同脚本放多个实例各自维护一份缓存。
 * =========================================================
 */

/* ===== 元数据（规范 v1，市场与列表页静态扫描） ===== */
const NAME = "ZEEHO 车辆（预览演示）";
const DESCRIPTION = "电动车电量 / 续航 / 胎压 / 骑行 / 积分（只读展示）";
const VERSION = "2.0.0";
const AUTHOR = "lswlc";
const MIN_ENGINE = "1.1";
const SIZES = ["4x2"];

/* ===== 脚本变量（应用「变量」页填写；唯一的必填项就是 token） ===== */
const PRESETS = {
    token: {
        title: "ZEEHO App Token（抓包获取）"
    }
};

/* ===== 配置 ===== */
var CONFIG = {
    /* 渲染返回的刷新间隔（秒，闹钟轮询） */
    REFRESH_SEC: 900,

    /* 两次真实网络请求的最小间隔（秒）：桌面曝光刷新很频繁，窗口内只渲染缓存 */
    MIN_FETCH_SEC: 300,

    /* 调试日志（logcat，TAG=CustomWidget） */
    DEBUG: false
};

/* ===== 协议常量（ZEEHO App 逆向，签名算法与 App 一致） ===== */
var APP_BASE = "https://tapi.zeehoev.com";
var SERVER_NAME = "SMART";
var APP_ID = "S7qPWPU1";
var APP_SECRET = "c5e0da7f4da28df805694ec3dd1fc6792e9df99d";

/* ===== 实例存储键 ===== */
var K_VIN = "demo2_vin";               // 缓存的车辆 VIN
var K_SNAP = "demo2_snap";             // 上次成功的数据快照 JSON
var K_LAST_FETCH = "demo2_last_fetch"; // 上次真实请求时间戳（ms）

/* 本次渲染的 token（render 开头从变量读取）与「Token 失效」标记 */
var TOKEN = "";
var EXPIRED = false;

/* =========================================================
 * 基础小工具
 * ========================================================= */

function trim(v) {
    return v === null || typeof v === "undefined" ? "" : String(v).replace(/^\s+|\s+$/g, "");
}

function str(v) {
    return v === null || typeof v === "undefined" ? "" : String(v);
}

function num(v) {
    if (v === null || typeof v === "undefined" || v === "") return null;
    var n = parseFloat(v);
    return isNaN(n) ? null : n;
}

/* 按顺序取第一个非空字段（容错服务端字段改名） */
function firstOf(obj, keys) {
    if (!obj) return null;
    for (var i = 0; i < keys.length; i++) {
        var v = obj[keys[i]];
        if (v === null || typeof v === "undefined") continue;
        if (typeof v === "string") {
            v = trim(v);
            if (!v || v === "null") continue;
        }
        return v;
    }
    return null;
}

function isOK(res) {
    return !!res && String(res.code) === "10000";
}

function pad2(n) {
    return n < 10 ? "0" + n : String(n);
}

/* =========================================================
 * 实例存储
 * ========================================================= */

function makeStore(ctx) {
    return {
        get: function (k) {
            var v = ctx.storeGet(k);
            return v === null || typeof v === "undefined" ? "" : String(v);
        },
        set: function (k, v) {
            ctx.storeSet(k, v === null || typeof v === "undefined" ? null : String(v));
        }
    };
}

function readSnap(S) {
    var raw = S.get(K_SNAP);
    if (!raw) return {};
    try {
        return JSON.parse(raw);
    } catch (e) {
        return {};
    }
}

/* =========================================================
 * 哈希：UTF-8 / MD5 / SHA1（纯 JS，供接口签名）
 * ========================================================= */

function utf8Bytes(str_) {
    str_ = String(str_);
    var bytes = [];
    for (var i = 0; i < str_.length; i++) {
        var c = str_.charCodeAt(i);
        if (c < 0x80) {
            bytes.push(c);
            continue;
        }
        if (c < 0x800) {
            bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
            continue;
        }
        if (c >= 0xd800 && c <= 0xdbff && i + 1 < str_.length) {
            var c2 = str_.charCodeAt(++i);
            var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
            bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
                0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
            continue;
        }
        bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return bytes;
}

/* 32 位字 → 4 字节十六进制。md5 输出小端、sha1 大端 */
function hex32le(n) {
    var s = "";
    for (var i = 0; i < 4; i++) {
        var v = (n >>> (i * 8)) & 0xff;
        s += (v < 16 ? "0" : "") + v.toString(16);
    }
    return s;
}

function hex32be(n) {
    var s = "";
    for (var i = 3; i >= 0; i--) {
        var v = (n >>> (i * 8)) & 0xff;
        s += (v < 16 ? "0" : "") + v.toString(16);
    }
    return s;
}

function md5Hex(input) {
    var bytes = utf8Bytes(input);
    var bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    for (var i = 0; i < 8; i++) bytes.push(Math.floor(bitLen / Math.pow(2, i * 8)) & 0xff);

    var K = [
        0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
        0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
        0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
        0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
        0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
        0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
        0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
        0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
        0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
        0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
        0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
        0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
        0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
        0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
        0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
        0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391
    ];
    var S = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
    ];

    function add32(a, b) { return (a + b) | 0; }
    function rol(x, n) { return ((x << n) | (x >>> (32 - n))) | 0; }
    function F(x, y, z) { return (x & y) | (~x & z); }
    function G(x, y, z) { return (x & z) | (y & ~z); }
    function H(x, y, z) { return x ^ y ^ z; }
    function I(x, y, z) { return y ^ (x | ~z); }

    var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

    for (var off = 0; off < bytes.length; off += 64) {
        var M = new Array(16);
        for (var j = 0; j < 16; j++) {
            var p = off + j * 4;
            M[j] = (bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)) | 0;
        }

        var A = a0, B = b0, C = c0, D = d0;
        for (var t = 0; t < 64; t++) {
            var f = t < 16 ? F : (t < 32 ? G : (t < 48 ? H : I));
            var g = t < 16 ? t : (t < 32 ? (5 * t + 1) % 16 : (t < 48 ? (3 * t + 5) % 16 : (7 * t) % 16));
            var fVal = f(B, C, D);
            var nb = add32(B, rol(add32(add32(add32(A, fVal), M[g]), K[t]), S[t]));
            A = D; D = C; C = B; B = nb;
        }

        a0 = add32(a0, A);
        b0 = add32(b0, B);
        c0 = add32(c0, C);
        d0 = add32(d0, D);
    }

    return hex32le(a0) + hex32le(b0) + hex32le(c0) + hex32le(d0);
}

function sha1Hex(input) {
    var bytes = utf8Bytes(input);
    var bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    for (var i = 7; i >= 0; i--) bytes.push(Math.floor(bitLen / Math.pow(2, i * 8)) & 0xff);

    function rol(x, n) { return ((x << n) | (x >>> (32 - n))) | 0; }

    var h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;

    for (var off = 0; off < bytes.length; off += 64) {
        var w = new Array(80);
        var t;
        for (t = 0; t < 16; t++) {
            var p = off + t * 4;
            w[t] = ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) | 0;
        }
        for (t = 16; t < 80; t++) {
            w[t] = rol(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
        }

        var a = h0, b = h1, c = h2, d = h3, e = h4;
        for (t = 0; t < 80; t++) {
            var f, k;
            if (t < 20) { f = (b & c) | ((~b) & d); k = 0x5a827999; }
            else if (t < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
            else if (t < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
            else { f = b ^ c ^ d; k = 0xca62c1d6; }
            var temp = (rol(a, 5) + f + e + k + w[t]) | 0;
            e = d; d = c; c = rol(b, 30); b = a; a = temp;
        }

        h0 = (h0 + a) | 0;
        h1 = (h1 + b) | 0;
        h2 = (h2 + c) | 0;
        h3 = (h3 + d) | 0;
        h4 = (h4 + e) | 0;
    }

    return hex32be(h0) + hex32be(h1) + hex32be(h2) + hex32be(h3) + hex32be(h4);
}

/* =========================================================
 * 签名（与 ZEEHO App / Loon 脚本一致，已验证可用）
 *
 *   h5 域：s = query（body 永不参与），nonce = UUID v4
 *   app 域：s = query + body，nonce = 时间戳 + 16 位随机串
 *   raw = s + "appId=..&nonce=..&timestamp=.." + SECRET
 *   sign = md5( sha1(raw) )   小写 hex
 *   注意：query 值不做 URL 编码
 * ========================================================= */

function randomChars(len) {
    var chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    var out = "";
    for (var i = 0; i < len; i++) {
        out += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return out;
}

function buildQuery(params) {
    var keys = [];
    for (var k in params) {
        if (!params.hasOwnProperty(k)) continue;
        var v = params[k];
        if (v === null || typeof v === "undefined" || String(v) === "") continue;
        keys.push(k);
    }
    keys.sort();
    var parts = [];
    for (var i = 0; i < keys.length; i++) {
        parts.push(keys[i] + "=" + String(params[keys[i]]));
    }
    return parts.join("&");
}

/* 定参签名（nonce/timestamp 由外部注入，便于测试） */
function signRaw(params, bodyText, nonce, ts) {
    var query = buildQuery(params);
    var s = query + (bodyText || "");
    var raw = s + "appId=" + APP_ID + "&nonce=" + nonce + "&timestamp=" + ts + APP_SECRET;
    return md5Hex(sha1Hex(raw));
}

function createSignature(params, bodyText) {
    var ts = new Date().getTime();
    var nonce = String(ts) + randomChars(16);
    return {
        nonce: nonce,
        timestamp: ts,
        sign: signRaw(params, bodyText, nonce, ts),
        query: buildQuery(params)
    };
}

/* =========================================================
 * HTTP（ctx.http 扩展形态；8 秒超时，HTTP≥400 不抛错）
 * ========================================================= */

function apiRequest(method, base, path, params, bodyObj) {
    /* 预览演示版：不发网络请求，直接返回假数据 */
    var key = function (p) { return String(p || "").toLowerCase(); };
    if (key(path).indexOf("/vehicle/list") >= 0) {
        return { code: "10000", data: [{ vinNo: "DEMO0001", vehicleName: "ZEEHO AE8" }] };
    }
    if (key(path).indexOf("widget") >= 0) {
        return { code: "10000", data: { bmssoc: 76, hmiRidableMile: 63, vehicleName: "ZEEHO AE8" } };
    }
    if (key(path).indexOf("battery") >= 0) return { code: "10000", data: { chargeStateStr: "未充电" } };
    if (key(path).indexOf("tire") >= 0) {
        return { code: "10000", data: { realTimeData: [
            { sensorPosition: 1, tirePressure: 2.25, warningType: 0 },
            { sensorPosition: 2, tirePressure: 2.30, warningType: 0 }
        ] } };
    }
    if (key(path).indexOf("ride") >= 0) return { code: "10000", data: { rideMileageDay: 12.4, lastRidingTimeUnitMinute: 35 } };
    if (key(path).indexOf("integral") >= 0) return { code: "10000", data: { integralTotal: 1280 } };
    return { code: "10000", data: {} };
}

/* 单路请求容错：失败只记日志返回 null，不阻断其它数据源 */
function callSafe(label, fn) {
    if (EXPIRED) return null;
    try {
        return fn();
    } catch (e) {
        ctx.log(label + " 失败: " + e);
        return null;
    }
}

/* 流程间隔。优先用系统 sleep（不空转烧 CPU），失败退化忙等 */
/* =========================================================
 * 接口
 * ========================================================= */

function fetchVehicleList() {
    return apiRequest("GET", APP_BASE, "/v1.0/app/cfmotoserverapp/vehicle/list", {}, null);
}

function fetchWidgets(vin) {
    return apiRequest("GET", APP_BASE,
        "/v1.0/app/cfmotoserverapp/vehicle/widgets/" + encodeURIComponent(vin), {}, null);
}

function fetchBattery(vin) {
    return apiRequest("GET", APP_BASE,
        "/v1.0/app/cfmotoserverapp/batteryInfo/" + encodeURIComponent(vin), {}, null);
}

function fetchTire(vin) {
    return apiRequest("GET", APP_BASE,
        "/v1.0/app/cfmotoserverapp/app/vehicle/tire/monitoring",
        { vinNo: vin, timePeriodType: "0" }, null);
}

function fetchHomeRide(vin) {
    return apiRequest("GET", APP_BASE,
        "/v1.0/app/cfmotoserverapp/homeRideInfo", { vinNo: vin }, null);
}

function fetchTotalPoints() {
    return apiRequest("GET", APP_BASE,
        "/v1.0/mine/cfmotoservermine/integral/totalIntegral", {}, null);
}

function clampPct(v) {
    if (v === null) return null;
    var n = Math.round(v);
    if (n < 0) n = 0;
    if (n > 100) n = 100;
    return n;
}

/* 胎压：sensorPosition 1=前 2=后；缺失时按数组顺序兜底 */
function parseTire(data) {
    var list = data && data.realTimeData;
    if (!list || !list.length) return null;
    var front = null, rear = null;
    for (var i = 0; i < list.length; i++) {
        var it = list[i];
        if (!it) continue;
        var pos = num(it.sensorPosition);
        if (pos === 1 && front === null) front = it;
        else if (pos === 2 && rear === null) rear = it;
        else if (front === null) front = it;
        else if (rear === null) rear = it;
    }
    function one(item) {
        if (!item) return "未绑定";
        var p = num(item.tirePressure);
        if (num(item.warningType) === 0 && p !== null && p > 0) return p.toFixed(2) + "bar";
        return "未绑定";
    }
    if (front === null && rear === null) return null;
    return "前 " + one(front) + " · 后 " + one(rear);
}

function parseRide(data) {
    if (!data) return null;
    var today = num(data.rideMileageDay);
    var dur = num(data.lastRidingTimeUnitMinute);
    var last = num(data.lastRideMileage);
    var durPart = dur !== null && dur > 0 ? " · " + Math.round(dur) + "分" : "";
    if (today !== null && today > 0) return today.toFixed(1) + "km" + durPart;
    if (last !== null && last > 0) return "最近 " + last.toFixed(1) + "km" + durPart;
    return "今日暂无骑行";
}

/* 签到状态：nowSignDetailVos 里严格匹配今天（signStatue=3 已签），
 * 兜底用 lastTime 归一化后的日期 */
function ensureVin(S, snap) {
    var res = callSafe("车辆列表", fetchVehicleList);
    if (EXPIRED || !isOK(res) || !res.data || !res.data.length) return;
    var v0 = res.data[0] || {};
    var vin = trim(firstOf(v0, ["vinNo", "frameNo"]));
    if (!vin) return;
    S.set(K_VIN, vin);
    snap.name = trim(firstOf(v0, ["vehicleName", "vehicleType", "deviceName"])) || "我的车辆";
}

/* 拉取车辆面板全部数据源，成功的合并进快照；有新数据则落盘 */
function fetchVehicleData(ctx, S, snap, vin) {
    var anyFresh = false;

    var w = callSafe("车辆面板", function () { return fetchWidgets(vin); });
    if (EXPIRED) return;
    if (isOK(w) && w.data) {
        var pct = clampPct(num(firstOf(w.data, ["bmssoc", "batteryLevel"])));
        if (pct !== null) { snap.pct = pct; anyFresh = true; }
        var range = num(firstOf(w.data, ["hmiRidableMile", "vehicleRidableMile", "ridableMileage"]));
        if (range !== null && range >= 0) { snap.range = Math.round(range); anyFresh = true; }
        var nm = trim(w.data.vehicleName);
        if (nm) { snap.name = nm; anyFresh = true; }
    }

    var bi = callSafe("充电状态", function () { return fetchBattery(vin); });
    if (EXPIRED) return;
    if (isOK(bi) && bi.data) {
        snap.chargeText = trim(bi.data.chargeStateStr) || "未充电";
        anyFresh = true;
    }

    var tp = callSafe("胎压", function () { return fetchTire(vin); });
    if (EXPIRED) return;
    if (isOK(tp)) {
        var tire = parseTire(tp.data);
        if (tire) { snap.tire = tire; anyFresh = true; }
    }

    var hr = callSafe("骑行数据", function () { return fetchHomeRide(vin); });
    if (EXPIRED) return;
    if (isOK(hr)) {
        var ride = parseRide(hr.data);
        if (ride) { snap.ride = ride; anyFresh = true; }
    }

    var ti = callSafe("积分", fetchTotalPoints);
    if (EXPIRED) return;
    if (isOK(ti) && ti.data) {
        var points = num(firstOf(ti.data, ["integralTotal", "totalIntegral", "integral", "score"]));
        if (points !== null) { snap.points = Math.round(points); anyFresh = true; }
    }

    if (anyFresh) {
        snap.updatedAt = ctx.time("HH:mm");
        S.set(K_SNAP, JSON.stringify(snap));
    }
}

/* =========================================================
 * 渲染
 * ========================================================= */

/* Token 失效态：提示 + 缓存数据 */
function expiredSpec(ctx, snap) {
    return {
        title: snap.name || "ZEEHO 车辆",
        chip: "Token 失效",
        big: "请更新 TOKEN",
        rows: [
            ["说明", "登录凭据已过期"],
            ["操作", "应用「变量」页更新 token"],
            ["缓存", snap.updatedAt ? "截至 " + snap.updatedAt : "无"]
        ],
        tap: "config",
        refresh: CONFIG.REFRESH_SEC
    };
}

/* 未配置 token 态：先把话说清楚，别混进「未获取到车辆列表」 */
function noTokenSpec() {
    return {
        title: "ZEEHO 车辆",
        chip: "未配置",
        big: "请填写 token",
        rows: [
            ["说明", "应用「变量」页填 token"],
            ["来源", "ZEEHO App 抓包（登录凭据）"],
            ["之后", "填好点小组件刷新即可"]
        ],
        tap: "refresh",
        refresh: CONFIG.REFRESH_SEC
    };
}

/* 未取到车辆态 */
function noVehicleSpec(snap) {
    return {
        title: "ZEEHO 车辆",
        chip: "未绑定车辆",
        big: "--",
        rows: [
            ["说明", "未获取到车辆列表"],
            ["检查", "Token 是否有效 / 网络"],
            ["重试", "点击小组件刷新"]
        ],
        tap: "refresh",
        refresh: CONFIG.REFRESH_SEC
    };
}

function render(ctx) {
    EXPIRED = false;
    TOKEN = ctx.env("token", "");
    TOKEN = TOKEN || "DEMO";
    var S = makeStore(ctx);
    var snap = readSnap(S);

    /* —— 节流：距上次真实请求不足间隔时直接渲染缓存 —— */
    var nowMs = new Date().getTime();
    var lastFetch = parseInt(S.get(K_LAST_FETCH) || "0", 10) || 0;
    if ((nowMs - lastFetch) >= CONFIG.MIN_FETCH_SEC * 1000 || lastFetch === 0) {
        S.set(K_LAST_FETCH, String(nowMs));

        var vin = S.get(K_VIN);
        if (!vin && !EXPIRED) {
            ensureVin(S, snap);
            vin = S.get(K_VIN);
        }
        if (!EXPIRED && vin) fetchVehicleData(ctx, S, snap, vin);
    }

    if (EXPIRED) return expiredSpec(ctx, snap);
    if (!S.get(K_VIN)) return noVehicleSpec(snap);

    /* —— 组装显示（经典字段模板，4 行） —— */
    var charge = str(snap.chargeText) || "--";
    var big = snap.pct !== undefined
        ? snap.pct + "%" + (snap.range !== undefined ? " · " + snap.range + "km" : "")
        : "--";

    return {
        title: snap.name || "ZEEHO 车辆",
        chip: charge + (snap.updatedAt ? " · " + str(snap.updatedAt) : ""),
        big: big,
        /* 4×2 的经典模板只显示 3 行（第 4 行会被裁掉），数据更新时间放在右上角 chip 里 */
        rows: [
            ["胎压", str(snap.tire) || "--"],
            ["骑行", str(snap.ride) || "--"],
            ["积分", snap.points !== undefined ? snap.points + " 分" : "--"]
        ],
        progress: snap.pct !== undefined ? { value: snap.pct, max: 100 } : undefined,
        tap: "refresh",
        refresh: CONFIG.REFRESH_SEC
    };
}
