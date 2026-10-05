#!/usr/bin/env node
/**
 * 市场索引工具：扫描 scripts/<id>/ 并校验，生成 scripts.json（应用后端）。
 *
 *   node tools/build-index.mjs          # 校验 + 生成/更新 scripts.json
 *   node tools/build-index.mjs --check  # 只校验（CI 的 PR 关卡），不写文件
 *
 * 校验规则与 App 端 engine/ScriptMeta.kt（元数据静态扫描）保持同一套口径：
 * 只认字面量常量、扫描 `function render` 之前的代码区、VERSION 必须 semver。
 * 索引内容除 generatedAt 外完全由仓库内容决定，重复运行不产生 diff。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');
const INDEX_FILE = path.join(ROOT, 'scripts.json');
const CHECK_ONLY = process.argv.includes('--check');

const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const RESERVED_IDS = new Set(['assets', 'preview', 'market', 'index', 'tools', 'web', 'scripts']);
const CATEGORIES = ['时钟', '系统', '电量', '网络', '天气', '效率', '示例', '其他'];
const SIZES = ['2x2', '4x2', '4x4'];
const ASSET_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];
const PREVIEW_EXT = ['.png', '.jpg', '.jpeg', '.webp'];
const RISKY = [['shell', /\bctx\s*\.\s*shell\s*\(/], ['file', /\bctx\s*\.\s*file\s*\(/],
  ['http', /\bctx\s*\.\s*http\s*\(/], ['httpBinary', /\bctx\s*\.\s*httpBinary\s*\(/]];

const LIMITS = {
  js: 64 * 1024,
  assetOne: 1024 * 1024,
  assetsTotal: 4 * 1024 * 1024,
  previewOne: 1024 * 1024,
};

const problems = [];
function fail(msg) { problems.push(msg); }

function walk(dir, base = dir) {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...walk(full, base));
    else out.push({ full, rel: path.relative(base, full).replaceAll('\\', '/'), size: st.size });
  }
  return out;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 与 App 的 ScriptMeta.parse 同口径：扫描 render 之前的区域，取字面量。 */
function parseMeta(source) {
  const cut = source.indexOf('function render');
  const region = cut > 0 ? source.slice(0, cut) : source.split('\n').slice(0, 80).join('\n');
  const str = (key) => {
    const m = region.match(new RegExp('const\\s+' + key + '\\s*=\\s*"([^"]*)"'));
    return m ? m[1] : null;
  };
  const sizesMatch = region.match(/const\s+SIZES\s*=\s*\[([^\]]*)\]/);
  const sizes = sizesMatch
    ? [...sizesMatch[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]).filter((s) => SIZES.includes(s))
    : [];
  return {
    name: str('NAME'), description: str('DESCRIPTION'), version: str('VERSION'),
    author: str('AUTHOR'), minEngine: str('MIN_ENGINE'), sizes,
  };
}

function gitDate(id) {
  try {
    return execFileSync('git', ['log', '-1', '--format=%cs', '--', `scripts/${id}`],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { return null; }
}

function build() {
  if (!fs.existsSync(SCRIPTS_DIR)) {
    fail('缺少 scripts/ 目录');
    return { schema: 1, repository: 'https://github.com/lswlc33/HyperWidgetMarket', scripts: [] };
  }

  const scripts = [];
  const ids = fs.readdirSync(SCRIPTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name).sort();

  for (const id of ids) {
    const dir = path.join(SCRIPTS_DIR, id);
    const rel = `scripts/${id}`;
    if (!ID_RE.test(id)) fail(`${rel}：文件夹名必须是 ASCII 小写 kebab-case（^[a-z0-9][a-z0-9-]{1,39}$）`);
    if (RESERVED_IDS.has(id)) fail(`${rel}：此 id 是工具保留名，请换一个`);
    if (problems.length) continue;

    // 允许的条目：<id>.js / assets/ / preview/ / market.json / README.md
    const allowed = new Set([`${id}.js`, 'assets', 'preview', 'market.json', 'README.md']);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!allowed.has(entry.name)) fail(`${rel}：不允许的条目 ${entry.name}（只允许 ${id}.js / assets/ / preview/ / market.json / README.md）`);
    }

    const jsFile = path.join(dir, `${id}.js`);
    if (!fs.existsSync(jsFile)) { fail(`${rel}：缺少 ${id}.js（文件必须与文件夹同名）`); continue; }
    const jsStat = fs.statSync(jsFile);
    if (jsStat.size > LIMITS.js) fail(`${rel}：${id}.js 超过 64KB（${(jsStat.size / 1024).toFixed(1)}KB）`);
    const source = fs.readFileSync(jsFile, 'utf8');

    if (!source.includes('function render')) fail(`${rel}：脚本必须定义 function render(ctx)`);
    const meta = parseMeta(source);
    for (const key of ['name', 'description', 'version', 'author']) {
      if (!meta[key]) fail(`${rel}：缺少元数据常量 ${key.toUpperCase()}（只允许字面量，见开发手册 §2.2）`);
    }
    if (meta.version && !/^\d+\.\d+\.\d+([-+].*)?$/.test(meta.version)) fail(`${rel}：VERSION 必须是 主.次.修订（semver）`);
    if (meta.sizes.length === 0) fail(`${rel}：SIZES 至少声明一个尺寸（2x2 / 4x2 / 4x4）`);

    // 资源
    const assets = [];
    let assetsBytes = 0;
    const assetsDir = path.join(dir, 'assets');
    if (fs.existsSync(assetsDir)) {
      for (const f of walk(assetsDir)) {
        if (f.rel.split('/').some((seg) => seg.startsWith('.') || seg === '..')) { fail(`${rel}：非法资源路径 ${f.rel}`); continue; }
        const ext = path.extname(f.rel).toLowerCase();
        if (!ASSET_EXT.includes(ext)) { fail(`${rel}：不支持的资源格式 ${f.rel}（允许 ${ASSET_EXT.join(' ')}）`); continue; }
        if (f.size > LIMITS.assetOne) { fail(`${rel}：单个资源超过 1MB（${f.rel}）`); continue; }
        assetsBytes += f.size;
        assets.push({ path: `assets/${f.rel}`, bytes: f.size, sha256: sha256(f.full) });
      }
      if (assets.length && assetsBytes > LIMITS.assetsTotal) fail(`${rel}：assets/ 合计超过 4MB`);
    }

    // 截图
    const previews = [];
    const previewDir = path.join(dir, 'preview');
    if (fs.existsSync(previewDir)) {
      for (const f of walk(previewDir)) {
        const m = /^([2-9]x[2-9])(-dark)?\.(png|jpe?g|webp)$/i.exec(path.basename(f.rel));
        if (!m || f.rel.includes('/')) { fail(`${rel}：截图命名必须是 <尺寸>.png / <尺寸>-dark.png（如 4x2.png），收到 ${f.rel}`); continue; }
        const size = m[1].toLowerCase();
        if (!SIZES.includes(size)) { fail(`${rel}：截图尺寸 ${size} 不在 2x2/4x2/4x4 内（${f.rel}）`); continue; }
        const ext = path.extname(f.rel).toLowerCase();
        if (!PREVIEW_EXT.includes(ext)) { fail(`${rel}：截图格式不支持（${f.rel}）`); continue; }
        if (f.size > LIMITS.previewOne) { fail(`${rel}：截图超过 1MB（${f.rel}）`); continue; }
        previews.push({ size, dark: Boolean(m[2]), path: `preview/${f.rel}`, bytes: f.size });
      }
      previews.sort((a, b) => SIZES.indexOf(a.size) - SIZES.indexOf(b.size) || Number(a.dark) - Number(b.dark));
    }

    // 市场附加信息
    let market = {};
    const marketFile = path.join(dir, 'market.json');
    if (fs.existsSync(marketFile)) {
      try { market = JSON.parse(fs.readFileSync(marketFile, 'utf8')); }
      catch (e) { fail(`${rel}：market.json 不是合法 JSON（${e.message}）`); }
    }
    if (market.category && !CATEGORIES.includes(market.category)) {
      fail(`${rel}：分类「${market.category}」不在清单内（${CATEGORIES.join(' / ')}）`);
    }
    if (market.tags && (!Array.isArray(market.tags) || market.tags.length > 5 || market.tags.some((t) => typeof t !== 'string'))) {
      fail(`${rel}：tags 必须是字符串数组且不超过 5 个`);
    }

    const uses = RISKY.filter(([, re]) => re.test(source)).map(([name]) => name);
    if (uses.includes('shell')) console.log(`  ⚠ ${rel} 会调用 ctx.shell（脚本以 root/壳权限执行命令，请人工确认用途）`);

    scripts.push({
      id,
      name: meta.name,
      description: meta.description,
      version: meta.version,
      author: meta.author,
      sizes: SIZES.filter((s) => meta.sizes.includes(s)),
      minEngine: meta.minEngine,
      updatedAt: gitDate(id) || fs.statSync(jsFile).mtime.toISOString().slice(0, 10),
      path: rel,
      entry: `${id}.js`,
      jsBytes: jsStat.size,
      jsSha256: sha256(jsFile),
      assets,
      previews,
      official: market.official === true,
      category: market.category || '其他',
      tags: market.tags || [],
      license: market.license || null,
      changelog: market.changelog || null,
      uses,
    });
  }

  return {
    schema: 1,
    repository: 'https://github.com/lswlc33/HyperWidgetMarket',
    scripts,
  };
}

const index = build();

if (problems.length) {
  console.error(`\n校验未通过，共 ${problems.length} 个问题：`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}

const withTime = { schema: index.schema, generatedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), repository: index.repository, scripts: index.scripts };
const json = JSON.stringify(withTime, null, 2) + '\n';

if (CHECK_ONLY) {
  console.log(`校验通过：${index.scripts.length} 个脚本（--check 模式，未写文件）`);
  process.exit(0);
}

// 索引内容（除 generatedAt 外）没变就不落盘，避免 CI 反复提交空 diff
let keep = false;
if (fs.existsSync(INDEX_FILE)) {
  try {
    const old = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    delete old.generatedAt;
    keep = JSON.stringify(old) === JSON.stringify({ schema: index.schema, repository: index.repository, scripts: index.scripts });
  } catch { keep = false; }
}
if (keep) {
  console.log(`索引无变化：${index.scripts.length} 个脚本（保留原文件）`);
} else {
  fs.writeFileSync(INDEX_FILE, json);
  console.log(`已生成 scripts.json：${index.scripts.length} 个脚本`);
}
