/*
 * 极核（ZEEHO）精简版脚本的沙箱冒烟测试：
 * 用 mock ctx 跑 render()，覆盖 ① 正常取数 ② 没填 token ③ 接口 401 ④ 只有缓存快照（节流窗口内）
 * 只验「脚本能跑通 + 数据映射对」，接口本身由真机上的原版验证过。
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SCRIPT = process.argv[2] || path.join(__dirname, '..', 'scripts', 'zeeho-scooter', 'zeeho-scooter.js');
const src = fs.readFileSync(SCRIPT, 'utf8');

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m) => { fail++; console.log('  ✗ ' + m); };

function run({ token = 'TESTTOKEN', http }) {
  const store = {};
  const calls = [];
  const ctx = {
    env: (k, d) => (k === 'token' ? token : d),
    storeGet: (k) => (store[k] === undefined ? null : store[k]),
    storeSet: (k, v) => { if (v === null) delete store[k]; else store[k] = String(v); },
    time: () => '12:00',
    log: (m) => calls.push('log:' + m),
    http: (opts) => { calls.push(opts.url); return http(opts); },
    size: () => ({ w: 350, h: 166 }),
    sizeClass: () => '4x2',
    device: () => ({ model: 'test', androidVersion: 14, isDarkMode: true }),
    meta: () => ({ name: 'ZEEHO 车辆', isPreview: true, widgetId: -100 }),
  };
  const sandbox = { ctx, console, Date, JSON, Math, String, Number, parseInt, parseFloat, isNaN, RegExp, Object, Array };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { spec: vm.runInContext('render(ctx)', sandbox), calls, store };
}

const OK = (data) => ({ status: 200, ok: true, body: JSON.stringify({ code: '10000', data }) });

console.log('== 正常取数 ==');
{
  const { spec, calls } = run({
    http: (o) => {
      if (o.url.includes('/vehicle/list')) return OK([{ vinNo: 'VINTEST01', vehicleName: '测试车' }]);
      if (o.url.includes('widget')) return OK({ bmssoc: 73, hmiRidableMile: 58, vehicleName: '测试车' });
      if (o.url.includes('battery')) return OK({ chargeStateStr: '未充电' });
      if (o.url.includes('tire')) return OK({});
      if (o.url.includes('ride')) return OK({});
      if (o.url.includes('integral')) return OK({ integralTotal: 1280 });
      return OK({});
    },
  });
  if (spec.title === '测试车' && /73%/.test(spec.big) && /58km/.test(spec.big)) ok('标题/大数字映射正确：' + spec.big);
  else bad('映射异常：' + JSON.stringify({ title: spec.title, big: spec.big }));
  if (spec.rows.length === 4 && spec.rows[2][1] === '1280 分') ok('行数据正确：' + JSON.stringify(spec.rows));
  else bad('行数据异常：' + JSON.stringify(spec.rows));
  if (spec.progress && spec.progress.value === 73) ok('进度条 73/100');
  else bad('进度条异常：' + JSON.stringify(spec.progress));
  if (calls.filter((u) => u.includes('http')).length >= 5) ok('一次渲染完成 ' + calls.filter((u) => u.includes('http')).length + ' 个接口调用');
  else bad('接口调用数异常：' + calls.length);
  if (/Bearer TESTTOKEN/.test(JSON.stringify(calls))) ok('请求带上了 Bearer token');
}

console.log('\n== 节流：第二次渲染不再请求 ==');
{
  const store = {};
  let hits = 0;
  const mk = () => ({
    env: (k, d) => (k === 'token' ? 'T' : d),
    storeGet: (k) => (store[k] === undefined ? null : store[k]),
    storeSet: (k, v) => { if (v === null) delete store[k]; else store[k] = String(v); },
    time: () => '12:00', log: () => {},
    http: (o) => { hits++; return o.url.includes('/vehicle/list') ? OK([{ vinNo: 'V1', vehicleName: '车' }]) : OK({}); },
    size: () => ({ w: 350, h: 166 }), sizeClass: () => '4x2',
    device: () => ({ isDarkMode: true }), meta: () => ({ widgetId: -100, isPreview: true }),
  });
  const ctx1 = mk();
  let sb = { ctx: ctx1, console, Date, JSON, Math, String, Number, parseInt, parseFloat, isNaN, RegExp, Object, Array };
  vm.createContext(sb); vm.runInContext(src, sb);
  vm.runInContext('render(ctx)', sb);
  const first = hits;
  vm.runInContext('render(ctx)', sb);      // 同一实例、同一秒：应命中节流
  if (hits === first) ok('第二次渲染 0 请求（命中节流，用缓存快照）');
  else bad('节流未生效：' + first + ' -> ' + hits);
}

console.log('\n== 没填 token ==');
{
  const { spec } = run({ token: '', http: () => OK({}) });
  if (spec.big === '请填写 token' && spec.chip === '未配置') ok('给出「请填写 token」状态卡');
  else bad('未给出提示：' + JSON.stringify(spec).slice(0, 160));
}

console.log('\n== 接口 401 ==');
{
  const { spec } = run({
    http: (o) => (o.url.includes('/vehicle/list')
      ? { status: 401, ok: false, body: '{"code":"401"}' }
      : { status: 200, ok: true, body: '{"code":"10000","data":{}}' }),
  });
  if (/Token 失效/.test(spec.chip || '')) ok('显示「Token 失效」并把操作指到变量页');
  else bad('失效态异常：' + JSON.stringify(spec).slice(0, 160));
  if ((spec.rows || []).some((r) => r[0] === '操作' && /变量/.test(r[1]))) ok('失效卡提示「应用「变量」页更新 token」');
  else bad('失效卡文案未更新：' + JSON.stringify(spec.rows));
}

console.log('\n' + (fail === 0 ? '全部通过 (' + pass + ')' : '有失败项: ' + fail));
process.exit(fail === 0 ? 0 : 1);
