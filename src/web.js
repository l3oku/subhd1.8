export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0443a2"/>
      <stop offset="1" stop-color="#009bde"/>
    </linearGradient>
  </defs>
  <rect width="256" height="256" rx="48" fill="url(#g)"/>
  <text x="128" y="112" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="62" font-weight="700" fill="#ffffff">SUB</text>
  <text x="128" y="176" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="58" font-weight="700" fill="#ffffff">HD</text>
  <rect x="46" y="196" width="164" height="10" rx="5" fill="#ffd166"/>
</svg>`;

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export function landingPage({ baseUrl }) {
  const manifestUrl = `${baseUrl}/manifest.json`;
  const installUrl = manifestUrl.replace(/^https?:\/\//, 'stremio://');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>中文字幕 · Stremio 插件</title>
<link rel="icon" href="/assets/logo.svg">
<style>
  :root {
    color-scheme: dark;
    --bg: #0e1117;
    --card: #161b22;
    --line: #232b36;
    --text: #e6edf3;
    --muted: #9aa7b4;
    --accent: #009bde;
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { overflow-x: hidden; }           /* 手机上别让内容把页面撑宽 */
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
    -webkit-text-size-adjust: 100%;
  }
  .wrap {
    max-width: 960px;
    margin: 0 auto;
    padding: 20px 16px calc(48px + env(safe-area-inset-bottom));
  }

  /* ── 顶部 ── */
  header { display: flex; align-items: center; gap: 12px; min-width: 0; }
  header img { width: 48px; height: 48px; border-radius: 12px; flex: none; }
  header .titles { min-width: 0; }
  h1 { font-size: 19px; margin: 0; line-height: 1.3; }
  .sub { color: var(--muted); font-size: 13px; margin-top: 2px; }

  .card {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 16px;
    margin-top: 16px;
  }
  h2 { font-size: 16px; margin: 0 0 12px; }

  a.button, button.button {
    display: inline-flex; align-items: center; justify-content: center;
    background: linear-gradient(-45deg, #0443a2, #009bde);
    color: #fff; text-decoration: none; border: 0; border-radius: 10px;
    padding: 11px 18px; font-size: 15px; font-family: inherit; cursor: pointer;
    min-height: 42px;
  }
  a.button:active, button.button:active { opacity: .85; }

  /* ── 安装地址：整行一块，点一下复制 ── */
  .copy-row {
    display: flex; align-items: center; gap: 8px;
    margin-top: 14px;
    background: #0b0f14;
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 10px 10px 10px 12px;
    min-width: 0;
  }
  .copy-row .label { color: var(--muted); font-size: 12px; flex: none; }
  .copy-row code {
    flex: 1 1 auto; min-width: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    color: #cfd8e3;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    direction: ltr;
  }
  .copy-btn {
    flex: none;
    background: #1f2937; color: #cfd8e3; border: 1px solid #2b3646;
    border-radius: 8px; padding: 7px 12px; font-size: 13px; font-family: inherit; cursor: pointer;
  }
  .copy-btn:active { background: #263242; }
  .copy-btn.done { background: #14532d; border-color: #2f6f3f; color: #86efac; }

  .hint { color: var(--muted); font-size: 13px; margin-top: 12px; line-height: 1.65; }

  /* ── 搜索 ── */
  .search { display: flex; flex-direction: column; gap: 8px; }
  .search input[type=search], .search select {
    width: 100%;
    background: #0b0f14; border: 1px solid var(--line); border-radius: 10px;
    padding: 11px 12px; color: var(--text); font-size: 16px;  /* 16px：避免 iOS 聚焦时自动放大 */
    font-family: inherit;
  }
  .search select { appearance: none; background-image: none; }

  ul.results { list-style: none; margin: 14px 0 0; padding: 0; display: grid; gap: 10px; }
  li.item {
    display: flex; gap: 12px; align-items: flex-start;
    background: #12171e; border: 1px solid var(--line); border-radius: 12px; padding: 12px;
    min-width: 0;
  }
  li.item img { width: 52px; border-radius: 8px; flex: none; object-fit: cover; }
  .meta { flex: 1 1 auto; min-width: 0; }
  .title { font-weight: 600; font-size: 14px; word-break: break-word; }
  .file { color: var(--muted); font-size: 12px; word-break: break-all; margin-top: 2px; }
  .tags { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px; font-size: 12px; }
  .tag { border: 1px solid #2b3646; border-radius: 999px; padding: 1px 8px; color: #b8c4d1; white-space: nowrap; }
  .tag.badge { border-color: #2f6f3f; color: #7ee2a8; }
  .actions { display: flex; flex-direction: column; gap: 6px; flex: none; }
  .actions .button { padding: 8px 14px; font-size: 14px; min-height: 38px; }
  .ghost {
    background: transparent; border: 1px solid #2b3646; color: #c9d4e0;
    border-radius: 10px; padding: 7px 12px; text-decoration: none; font-size: 13px;
    text-align: center; white-space: nowrap;
  }
  .status { color: var(--muted); font-size: 13px; margin-top: 12px; }
  .status:empty { display: none; }
  .error { color: #ff8080; }

  /* ── 窄屏（手机）── */
  @media (max-width: 640px) {
    .wrap { padding: 16px 14px calc(40px + env(safe-area-inset-bottom)); }
    h1 { font-size: 17px; }
    header img { width: 42px; height: 42px; }
    li.item { flex-wrap: wrap; }
    /* 手机上下载按钮排成一行，占满整宽，不再挤在右边导致页面变宽 */
    .actions { flex-direction: row; flex-wrap: wrap; width: 100%; gap: 8px; }
    .actions .button, .ghost { flex: 1 1 auto; }
    .meta { width: 100%; }
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <img src="/assets/logo.svg" alt="">
    <div class="titles">
      <h1>中文字幕 · Stremio 插件</h1>
      <div class="sub">SubHD · 迅雷 · 射手(伪)</div>
    </div>
  </header>

  <div class="card">
    <a class="button" href="${escapeHtml(installUrl)}">在 Stremio 中安装</a>

    <div class="copy-row">
      <span class="label">安装地址</span>
      <code id="manifest-url">${escapeHtml(manifestUrl)}</code>
      <button class="copy-btn" type="button" id="copy-btn">复制</button>
    </div>

    <div class="hint">安装后：Stremio 打开任意影片 → 字幕 → 选「SubHD + 迅雷 + 射手(伪) 字幕」。</div>
  </div>

  <div class="card">
    <h2>网页搜索下载</h2>
    <form class="search" id="form">
      <input type="search" id="q" placeholder="片名，例如：沙丘 / 怪奇物语 / tt4574334" autocomplete="off" enterkeyhint="search">
      <select id="source">
        <option value="subhd">SubHD</option>
        <option value="thunder">迅雷</option>
        <option value="assrt">射手(伪)</option>
      </select>
      <button class="button" type="submit">搜索</button>
    </form>
    <div class="hint">支持中文名、英文名、IMDb ID。点「下载」直接拿到转好码的字幕文件。</div>
    <div class="status" id="status"></div>
    <ul class="results" id="results"></ul>
  </div>

  <div class="hint">仅供学习交流使用，字幕版权归原作者所有。</div>
</div>
<script>
const form = document.getElementById('form');
const sourceSelect = document.getElementById('source');
const input = document.getElementById('q');
const status = document.getElementById('status');
const results = document.getElementById('results');
const esc = (value) => String(value ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

/* 安装地址：点一下复制（不再需要长按选中） */
const copyBtn = document.getElementById('copy-btn');
const manifestText = document.getElementById('manifest-url').textContent;
copyBtn.addEventListener('click', async () => {
  const original = '复制';
  let ok = false;
  try {
    // 现代浏览器 / iOS Safari 14+ 都能用
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(manifestText);
      ok = true;
    }
  } catch {}
  if (!ok) {
    // 老浏览器 / 非 https：退回临时 textarea 选中复制
    const ta = document.createElement('textarea');
    ta.value = manifestText;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    try { ok = document.execCommand('copy'); } catch {}
    document.body.removeChild(ta);
  }
  copyBtn.textContent = ok ? '已复制' : '请长按';
  copyBtn.classList.toggle('done', ok);
  setTimeout(() => { copyBtn.textContent = original; copyBtn.classList.remove('done'); }, 1600);
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = input.value.trim();
  if (!query) return;
  status.className = 'status';
  status.textContent = '搜索中…';
  results.innerHTML = '';
  try {
    const source = sourceSelect && sourceSelect.value;
    const response = await fetch('/api/search?q=' + encodeURIComponent(query) + (source && source !== 'subhd' ? '&source=' + encodeURIComponent(source) : ''));
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    if (!data.entries.length) { status.textContent = '没有找到字幕。'; return; }
    status.textContent = '共 ' + (data.total || data.entries.length) + ' 条，显示前 ' + data.entries.length + ' 条';
    results.innerHTML = data.entries.map((entry) => {
      const tags = [entry.badge, entry.languageText || (entry.languages || []).join('/'), ...(entry.formats || []).map((f) => f.toUpperCase()), entry.group, entry.sizeText, entry.downloads ? entry.downloads + '次下载' : null, entry.publishedAt ? entry.publishedAt.slice(0, 10) : null]
        .filter(Boolean)
        .map((tag, index) => '<span class="tag' + (index === 0 && entry.badge ? ' badge' : '') + '">' + esc(tag) + '</span>')
        .join('');
      // SubHD：/sub/<编号> 是插件转好的文本；迅雷 / 射手(伪)：点「下载」由服务器取回来再转码
      const serverFile = entry.serverFile || entry.downloadUrl;
      const download = serverFile ? '<a class="button" href="' + esc(serverFile) + '">下载字幕</a>' : '';
      const raw = entry.rawUrl ? '<a class="ghost" href="' + esc(entry.rawUrl) + '">原始文件</a>' : '';
      const page = entry.pageUrl ? '<a class="ghost" href="' + esc(entry.pageUrl) + '" target="_blank" rel="noreferrer">站点页面</a>' : '';
      return '<li class="item">' +
        (entry.poster ? '<img src="' + esc(entry.poster) + '" alt="" loading="lazy">' : '') +
        '<div class="meta">' +
          '<div class="title">' + esc(entry.title) + '</div>' +
          '<div class="file">' + esc(entry.filename) + '</div>' +
          '<div class="tags">' + tags + '</div>' +
        '</div>' +
        '<div class="actions">' + download + raw + page + '</div>' +
      '</li>';
    }).join('');
  } catch (error) {
    status.className = 'status error';
    status.textContent = '搜索失败：' + error.message;
  }
});
</script>
</body>
</html>`;
}
