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
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SubHD 中文字幕 · Stremio 插件</title>
<link rel="icon" href="/assets/logo.svg">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; background: #0e1117; color: #e6edf3; }
  .wrap { max-width: 960px; margin: 0 auto; padding: 32px 20px 80px; }
  header { display: flex; align-items: center; gap: 16px; margin-bottom: 8px; }
  header img { width: 56px; height: 56px; border-radius: 12px; }
  h1 { font-size: 24px; margin: 0; }
  .sub { color: #9aa7b4; font-size: 14px; margin-top: 4px; }
  .card { background: #161b22; border: 1px solid #232b36; border-radius: 14px; padding: 18px; margin-top: 20px; }
  a.button, button.button { display: inline-block; background: linear-gradient(-45deg,#0443a2,#009bde); color: #fff; text-decoration: none; border: 0; border-radius: 10px; padding: 10px 18px; font-size: 15px; cursor: pointer; }
  code { background: #0b0f14; border: 1px solid #232b36; border-radius: 6px; padding: 2px 6px; font-size: 13px; word-break: break-all; }
  .search { display: flex; gap: 8px; margin-top: 12px; }
  input[type=search] { flex: 1; background: #0b0f14; border: 1px solid #232b36; border-radius: 10px; padding: 11px 14px; color: #e6edf3; font-size: 15px; }
  .hint { color: #9aa7b4; font-size: 13px; margin-top: 10px; line-height: 1.7; }
  ul.results { list-style: none; margin: 16px 0 0; padding: 0; display: grid; gap: 10px; }
  li.item { display: flex; gap: 12px; background: #12171e; border: 1px solid #232b36; border-radius: 12px; padding: 12px; }
  li.item img { width: 56px; border-radius: 8px; align-self: flex-start; object-fit: cover; }
  .meta { flex: 1; min-width: 0; }
  .title { font-weight: 600; margin-bottom: 4px; }
  .file { color: #9aa7b4; font-size: 13px; word-break: break-all; }
  .tags { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 6px; font-size: 12px; }
  .tag { border: 1px solid #2b3646; border-radius: 999px; padding: 2px 8px; color: #b8c4d1; }
  .tag.badge { border-color: #2f6f3f; color: #7ee2a8; }
  .actions { display: flex; flex-direction: column; gap: 8px; justify-content: center; }
  .actions a { white-space: nowrap; }
  .ghost { background: transparent; border: 1px solid #2b3646; color: #c9d4e0; border-radius: 10px; padding: 8px 14px; text-decoration: none; font-size: 14px; text-align: center; }
  .status { color: #9aa7b4; font-size: 14px; margin-top: 14px; }
  .error { color: #ff8080; }
  h2 { font-size: 17px; margin: 26px 0 0; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <img src="/assets/logo.svg" alt="SubHD">
    <div>
      <h1>SubHD 中文字幕 · Stremio 插件</h1>
      <div class="sub">搜索 subhd.tv 的字幕，并在 Stremio 里直接播放时加载</div>
    </div>
  </header>

  <div class="card">
    <a class="button" href="${escapeHtml(installUrl)}">在 Stremio 中安装</a>
    <div class="hint">
      手动安装地址：<code>${escapeHtml(manifestUrl)}</code><br>
      安装后：Stremio 打开任意影片 → 字幕 → 选择 “SubHD 中文字幕”；或在发现页选择本插件的目录搜索片名。
    </div>
  </div>

  <div class="card">
    <h2 style="margin-top:0">网页搜索下载</h2>
    <form class="search" id="form">
      <input type="search" id="q" placeholder="输入片名，例如：沙丘 / 怪奇物语 / tt4574334" autocomplete="off">
      <select id="source" style="background:#0b0f14;border:1px solid #232b36;border-radius:10px;color:#e6edf3;padding:11px 10px;font-size:14px">
        <option value="subhd">SubHD</option>
        <option value="thunder">迅雷</option>
        <option value="assrt">射手(伪)</option>
      </select>
      <button class="button" type="submit">搜索</button>
    </form>
    <div class="hint">支持中文名、英文名和 IMDb ID。SubHD：点「下载」得到 SRT/ASS 文本；迅雷 / 射手(伪)：点「下载」由插件服务器取文件并转成 UTF-8。</div>
    <div class="status" id="status"></div>
    <ul class="results" id="results"></ul>
  </div>

  <div class="hint" style="margin-top:22px">
    仅供学习交流使用，字幕版权归原作者所有。
  </div>
</div>
<script>
const form = document.getElementById('form');
const sourceSelect = document.getElementById('source');
const input = document.getElementById('q');
const status = document.getElementById('status');
const results = document.getElementById('results');
const esc = (value) => String(value ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

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
