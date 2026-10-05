/**
 * 市场展示页：运行时拉取 scripts.json（与 App 读的同一份索引）并渲染。
 * 纯静态、零依赖，全部过滤在浏览器内完成；网页不执行任何脚本。
 */
'use strict';

const RAW_BASE = 'https://raw.githubusercontent.com/lswlc33/HyperWidgetMarket/main';
const SIZE_LABEL = { '2x2': '2×2', '4x2': '4×2', '4x4': '4×4' };
const USE_LABEL = { shell: '调用 shell', file: '读取文件', http: '访问网络', httpBinary: '下载图片' };
const SIZE_ORDER = ['2x2', '4x2', '4x4'];

const state = { scripts: [], q: '', category: '全部', size: null, sort: 'updated' };
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 选一张展示图：优先目标尺寸，深色模式下有 dark 图就用 dark。 */
function pickPreview(script, prefer = '4x2') {
  const order = [prefer, ...SIZE_ORDER.filter((s) => s !== prefer)];
  for (const size of order) {
    const list = script.previews.filter((p) => p.size === size);
    if (!list.length) continue;
    const dark = list.find((p) => p.dark);
    const light = list.find((p) => !p.dark);
    const chosen = darkQuery.matches && dark ? dark : (light || dark);
    return { src: `${script.path}/${chosen.path}`, size };
  }
  return null;
}

function previewFor(script, size) {
  const list = script.previews.filter((p) => p.size === size);
  const dark = list.find((p) => p.dark);
  const light = list.find((p) => !p.dark);
  const chosen = darkQuery.matches && dark ? dark : (light || dark);
  return chosen ? { ...chosen, src: `${script.path}/${chosen.path}` } : null;
}

function kb(bytes) {
  return bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

function visible() {
  const q = state.q.trim().toLowerCase();
  let list = state.scripts.filter((s) => {
    if (state.category !== '全部' && s.category !== state.category) return false;
    if (state.size && !s.sizes.includes(state.size)) return false;
    if (!q) return true;
    const hay = [s.id, s.name, s.description, s.author, s.category, ...(s.tags || [])].join(' ').toLowerCase();
    return hay.includes(q);
  });
  if (state.sort === 'name') list = [...list].sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  else if (state.sort === 'version') list = [...list].sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  else list = [...list].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return list;
}

function badge(text, cls = '') {
  return `<span class="badge ${cls}">${esc(text)}</span>`;
}

function card(s) {
  const pv = pickPreview(s);
  const img = pv
    ? `<img src="${esc(pv.src)}" alt="${esc(s.name)} 预览" loading="lazy">`
    : `<div class="no-preview"><span>${esc(SIZE_LABEL[s.sizes[0]] || '')}</span></div>`;
  const uses = (s.uses || []).map((u) => USE_LABEL[u] || u);
  return `<article class="card" data-id="${esc(s.id)}" tabindex="0">
    <div class="thumb">${img}</div>
    <div class="card-body">
      <div class="title-row">
        <h3>${esc(s.name)}</h3>
        <span class="ver">v${esc(s.version)}</span>
      </div>
      <p class="desc">${esc(s.description)}</p>
      <div class="chips">
        ${s.official ? badge('官方', 'official') : ''}
        ${badge(s.category, 'cat')}
        ${s.sizes.map((z) => badge(SIZE_LABEL[z] || z)).join('')}
        ${uses.length && s.uses.includes('shell') ? badge('含 shell 调用', 'warn') : ''}
      </div>
      <p class="meta">${esc(s.author)} · ${esc(s.updatedAt || '')} · ${kb(s.jsBytes)}${s.assets.length ? ' · ' + s.assets.length + ' 个资源' : ''}</p>
    </div>
  </article>`;
}

function detailHtml(s) {
  const gallery = SIZE_ORDER.flatMap((size) => {
    const p = previewFor(s, size);
    return p ? `<figure><img src="${esc(p.src)}" alt="${esc(s.name)} ${size}"><figcaption>${SIZE_LABEL[size]}${p.dark && darkQuery.matches ? ' · 深色' : ''}</figcaption></figure>` : [];
  }).join('');
  const uses = (s.uses || []).map((u) => USE_LABEL[u] || u);
  const jsUrl = `${RAW_BASE}/${s.path}/${s.entry}`;
  const rows = [
    ['标识', s.id],
    ['分类', s.category],
    ['尺寸', s.sizes.map((z) => SIZE_LABEL[z] || z).join(' / ')],
    ['作者', s.author],
    ['许可证', s.license || '—'],
  ];
  return `${gallery ? `<div class="gallery">${gallery}</div>` : ''}
    <p class="detail-desc">${esc(s.description)}</p>
    ${s.changelog ? `<div class="block"><h4>更新说明</h4><p>${esc(s.changelog)}</p></div>` : ''}
    <dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    <div class="block">
      <h4>安装</h4>
      <ol class="steps">
        <li>应用底栏「市场」页搜索 <code>${esc(s.name)}</code> 后点安装（推荐）。</li>
        <li>或手动把下面的脚本文件放进 <code>Download/HyperWidget/</code>${s.assets.length ? `，并把 <code>assets/</code> 整个文件夹放进 <code>Download/HyperWidget/${esc(s.id)}/assets/</code>` : ''}。</li>
      </ol>
      <p class="fileline"><code>${esc(s.path + '/' + s.entry)}</code>
        <a class="linkbtn" href="${esc(jsUrl)}" target="_blank" rel="noopener">下载 JS</a>
        <a class="linkbtn" href="https://github.com/lswlc33/HyperWidgetMarket/tree/main/${esc(s.path)}" target="_blank" rel="noopener">仓库文件夹</a>
      </p>
    </div>
    ${uses.length ? `<div class="block warn-block"><h4>能力提示</h4><p>此脚本会${uses.join('、')}。脚本与应用内自建脚本能力相同，请确认来源可信后再安装。</p></div>` : ''}`;
}

function render() {
  const list = visible();
  $('grid').innerHTML = list.map(card).join('');
  $('count').textContent = `共 ${list.length} 个脚本${state.scripts.length !== list.length ? `（全部 ${state.scripts.length} 个）` : ''}`;
  $('empty').hidden = list.length > 0;
  document.querySelectorAll('.card').forEach((el) => {
    const open = () => openDetail(el.dataset.id);
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
}

function renderFilters() {
  const cats = ['全部', ...new Set(state.scripts.map((s) => s.category))];
  $('categoryFilters').innerHTML = cats.map((c) =>
    `<button class="filter ${c === state.category ? 'on' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('');
  $('categoryFilters').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    state.category = b.dataset.cat; renderFilters(); render();
  }));
  $('sizeFilters').innerHTML = SIZE_ORDER.map((z) =>
    `<button class="filter ${z === state.size ? 'on' : ''}" data-size="${z}">${SIZE_LABEL[z]}</button>`).join('');
  $('sizeFilters').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    state.size = state.size === b.dataset.size ? null : b.dataset.size; renderFilters(); render();
  }));
}

function openDetail(id) {
  const s = state.scripts.find((x) => x.id === id);
  if (!s) return;
  $('dTitle').textContent = `${s.name} · v${s.version}`;
  $('dBody').innerHTML = detailHtml(s);
  $('detail').showModal();
}

async function main() {
  try {
    const res = await fetch('scripts.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.scripts = data.scripts || [];
    renderFilters();
    render();
  } catch (e) {
    $('count').textContent = `索引加载失败：${e.message}（本地预览请用 http server 打开本页）`;
  }
}

$('search').addEventListener('input', (e) => { state.q = e.target.value; render(); });
$('sort').addEventListener('change', (e) => { state.sort = e.target.value; render(); });
$('dClose').addEventListener('click', () => $('detail').close());
$('detail').addEventListener('click', (e) => { if (e.target === $('detail')) $('detail').close(); });
darkQuery.addEventListener('change', render);

main();
