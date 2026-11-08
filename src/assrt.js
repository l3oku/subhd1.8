// 射手网（伪）assrt.net 的字幕。
//
// 两条路：
//   1. 配了 ASSRT_TOKEN（在 assrt.net 个人中心拿到的 API token）：走官方 API
//        GET https://api.assrt.net/v1/sub/search?token=…&q=<片名>&cnt=20
//        GET https://api.assrt.net/v1/sub/detail?token=…&id=<字幕 id>
//      返回里 filelist[].url 就是字幕文件的直链（也可能是个压缩包），最稳、最省事。推荐。
//   2. 没配 token：走网页
//        GET https://assrt.net/sub/?searchword=<片名>[&page=N]
//        详情 /xml/sub/<id/1000>/<id>.xml（字幕格式 / 语言 / 匹配视频 / 文件名）
//        下载 /download/<id>/<文件名>  → 302 到 file0.assrt.net
//      不用注册，但站点偶尔会在出口 IP 上掐一下；主站 TLS 只认 1.3（见 net.js）。
//
// 站点给的大多是「一个压缩包」，里面按语言分好几份文件。挑文件那套逻辑和 SubHD 共用，
// 所以「简体 / 繁体 / 双语」各成一条轨道，点开才去取（见 files.js）。
import { config } from './config.js';
import { TtlCache } from './cache.js';
import { fetchText, logSource } from './net.js';
import { cleanText, parseVideoId } from './parse.js';
import { clipMiddle, episodeSuffix } from './label.js';
import { addonMeta } from './meta.js';
import { extOfUrl, loadArchive } from './files.js';
import { checkIdentity, episodeRank, isWholeShow, normalize, seasonInfo } from './match.js';
import { aliasesFor } from './aliases.js';

export const isAssrtEnabled = () => true;
export const hasAssrtToken = () => config.assrt.token.length > 0;

const searchCache = new TtlCache({ ttlMs: 10 * 60 * 1000, maxEntries: 300 });
const detailCache = new TtlCache({ ttlMs: 30 * 60 * 1000, maxEntries: 400 });

// ------------------------------------------------ 语言 ------------------------------------------------

// 射手（伪）的语言标签是单字（简 / 繁 / 英 / 日 / 双语），像「英 简 双语」这样用空格分开；
// 网页里是 &nbsp;，解码后变成空格。返回给人看的串（第二行）和 Stremio 的 lang。
const ASSRT_LANGS = [
  [/中英|英中|双语|雙語|简英|繁英|简繁|英简|多语/i, '中英双语', 'zh'],
  [/简|簡|chs|zh-?cn|zh-?hans/i, '简体', 'zh-Hans'],
  [/繁|cht|zh-?tw|zh-?hant|big5/i, '繁体', 'zh-Hant'],
  [/英|eng/i, '英语', 'en'],
  [/日|jpn/i, '日语', 'ja'],
  [/韩|韓|kor/i, '韩语', 'ko'],
];

export function assrtLanguage(text) {
  const source = String(text || '');
  const labels = [];
  let code = 'zh';
  for (const [pattern, label, lang] of ASSRT_LANGS) {
    if (!pattern.test(source) || labels.includes(label)) continue;
    labels.push(label);
    if (code === 'zh') code = lang;
  }
  const bilingual = labels.includes('中英双语');
  // 中英双语的包本身就是一条轨道（简繁英都在一个文件里），简繁不用再各列一条；
  // 日语 / 韩语是另一份文件，照样单独算一条。
  const ordered = bilingual
    ? ['中英双语', ...labels.filter((label) => label === '日语' || label === '韩语')]
    : labels;
  const shown = ordered.length > 0 ? ordered.join('/') : '简体';
  const stremioLang = bilingual ? 'zh' : ['en', 'ja', 'ko', 'zh-Hant'].includes(code) ? code : 'zh';
  return { label: shown, code: stremioLang };
}

// ------------------------------------------------ 网页解析 ------------------------------------------------

const SEARCH_ITEM_SPLIT = /onmouseover="addclass\(this,'subitem_hover'\)"/;

function attr(tag, name) {
  return (String(tag || '').match(new RegExp(`${name}=["']([^"']*)["']`)) || [])[1] || '';
}

function safeDecode(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch {
    return String(value || '');
  }
}

/** 搜索页 → { total, page, pages, items } */
export function parseAssrtSearch(html) {
  const raw = String(html || '');
  const totalText = (raw.match(/找到\s*([\d,]+)\s*条/) || [])[1];
  const pageText = (raw.match(/<a[^>]*id="pl-current"[^>]*>(\d+)<\/a>/) || [])[1];
  const pagesText = (raw.match(/<a>\d+\/(\d+)<\/a>/) || [])[1];

  const items = [];
  for (const block of raw.split(SEARCH_ITEM_SPLIT).slice(1)) {
    const titleTag = (block.match(/<a[^>]*class="introtitle"[^>]*>/) || [])[0] || '';
    const href = attr(titleTag, 'href');
    const id = (href.match(/sub\/\d+\/(\d+)\.xml/) || [])[1] || (href.match(/sub\/(\d+)\.xml/) || [])[1];
    if (!id) continue;

    const title = cleanText(attr(titleTag, 'title'));
    const version = cleanText((block.match(/<span>版本：<b>([\s\S]*?)<\/b>/) || [])[1]);
    const format = cleanText((block.match(/格式：\s*([^<]*)<\/span>/) || [])[1]);
    const languages = cleanText((block.match(/语言：([^<]*)<\/span>/) || [])[1]).replace(/\u00a0/g, ' ').trim();
    const source = cleanText((block.match(/来源：\s*([^<]*)<\/span>/) || [])[1]);
    const date = (block.match(/日期：\s*([\d-]+\s[\d:]+)/) || [])[1] || '';
    const downloads = Number(((block.match(/下载次数：\s*([\d,]+)/) || [])[1] || '').replace(/,/g, '')) || 0;
    const views = Number(((block.match(/查阅次数：\s*([\d,]+)/) || [])[1] || '').replace(/,/g, '')) || 0;
    const ratingGif = (block.match(/\/images\/star\/(\d+)\.gif/) || [])[1];
    const stars = ratingGif ? Number(ratingGif) / 20 : 0;

    // 有的条目（最新字幕列表）把下载地址藏在 onclick 里的转义引号里
    const downloadHref =
      (block.match(/javascript:location\.href='([^']+)'/) || [])[1] ||
      (block.match(/javascript:location\.href=&quot;([^&]+)&quot;/) || [])[1] ||
      (block.match(/[/]download[/]\d+[/][^'"&)]+/) || [])[0] ||
      (block.match(/href="(\/download\/\d+\/[^"]+)"/) || [])[1] ||
      '';
    const filename = safeDecode(downloadHref.split('/').pop() || '');

    items.push({
      id: String(id),
      title,
      version,
      filename,
      format,
      languages,
      source,
      date,
      downloads,
      views,
      stars,
      downloadHref,
    });
  }

  return {
    total: totalText ? Number(String(totalText).replace(/,/g, '')) : items.length,
    page: Number(pageText) || 1,
    pages: Number(pagesText) || 1,
    items,
  };
}

/** 详情页 → { name, format, languages, source, note, matchedText, filename, sizeText } */
export function parseAssrtDetail(html) {
  const raw = String(html || '');
  const between = (label, stop) => {
    const index = raw.indexOf(label);
    if (index < 0) return '';
    const chunk = raw.slice(index + label.length, index + label.length + 1200);
    const end = chunk.indexOf(stop);
    return cleanText(end >= 0 ? chunk.slice(0, end) : chunk);
  };

  return {
    name: cleanText((raw.match(/id="movietitle1"[^>]*>([\s\S]*?)<\/span>/) || [])[1]),
    format: between('字幕格式：</span>', '</span>'),
    languages: between('字幕语种：</span>', '</span>').replace(/\u00a0/g, ' ').trim(),
    source: between('字幕来源：</span>', '</span>'),
    date: (raw.match(/发布时间：<\/span>\s*<span[^>]*>([\d-]+\s[\d:]+)/) || [])[1] || '',
    note: between('备注：</span>', '</div>'),
    matchedText: between('匹配视频：</span>', '</div>'),
    filename: (() => {
      const value = (raw.match(/文件名：([^<]*)/) || [])[1] || '';
      return cleanText(value);
    })(),
    sizeText: ((raw.match(/id="downsubbtnfsize">\s*([^<]*)</) || [])[1] || '').trim(),
    // 详情页上的「下载字幕」按钮：/download/<id>/<文件名>（302 到 file0.assrt.net）
    downloadHref:
      (raw.match(/javascript:location\.href='(\/download\/\d+\/[^']+)'/) || [])[1] ||
      (raw.match(/href="(\/download\/\d+\/[^"]+)"/) || [])[1] ||
      '',
  };
}

// 任何一条射手（伪）字幕的下载地址：详情页给了就用，没给就按「/download/<id>/<文件名>」拼一个
// （站点只看编号和文件名，名字对不上也能下）。
export function assrtDownloadHref(item) {
  if (item?.downloadHref) return item.downloadHref;
  const id = String(item?.id || '');
  if (!id) return '';
  const name = item.filename || item.name || `${id}.zip`;
  const withExt = /\.[A-Za-z0-9]{2,4}$/.test(name) ? name : `${name}.zip`;
  return `/download/${id}/${encodeURIComponent(withExt)}`;
}

// ------------------------------------------------ 写请求 ------------------------------------------------

async function apiCall(path, params) {
  const url = new URL(`${config.assrt.apiBase}${path}`);
  url.search = new URLSearchParams({ token: config.assrt.token, ...params }).toString();
  const response = await fetchText(url.toString(), { accept: 'application/json', timeoutMs: config.assrt.timeoutMs });
  if (!response.ok) throw new Error(`射手 API HTTP ${response.status}`);
  const body = JSON.parse(response.text);
  if (Number(body.status) !== 0) throw new Error(body.errmsg || `射手 API status ${body.status}`);
  return body;
}

async function apiSearch(query, page = 1) {
  const body = await apiCall('/v1/sub/search', {
    q: query,
    cnt: '20',
    pos: String(Math.max(0, page - 1) * 20),
    no_muxer: '1',
  });
  return (body.sub?.subs || []).map((item) => ({
    id: String(item.id),
    title: cleanText(item.videomenu || ''),
    version: cleanText(item.native_name || ''),
    filename: '',
    format: String(item.subtype || '').toUpperCase(),
    languages: typeof item.lang?.desc === 'string' ? item.lang.desc : '',
    source: '',
    date: String(item.upload_time || ''),
    downloads: Number(item.downloadcount) || 0,
    views: 0,
    stars: Number(item.vote_score) || 0,
    filelist: Array.isArray(item.filelist) ? item.filelist : [],
    downloadHref: item.url ? String(item.url) : '',
  }));
}

async function apiDetail(id) {
  const body = await apiCall('/v1/sub/detail', { id });
  const item = body.sub?.subs?.[0];
  if (!item) throw new Error('射手 API 没有返回这条字幕');
  return {
    name: cleanText(item.videomenu || ''),
    format: String(item.subtype || '').toUpperCase(),
    languages: typeof item.lang?.desc === 'string' ? item.lang.desc : '',
    note: '',
    filelist: (item.filelist || []).filter((file) => file && file.url),
  };
}

async function webGet(pathname, { referer = '' } = {}) {
  let lastError = null;
  for (const domain of config.assrt.domains) {
    const url = `https://${domain}${pathname}`;
    try {
      const response = await fetchText(url, { referer, timeoutMs: config.assrt.timeoutMs });
      if (response.ok) return { ...response, url, domain };
      lastError = new Error(`HTTP ${response.status}: ${url}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('射手（伪）无法访问');
}

export async function webSearch(query, page = 1) {
  const suffix = page > 1 ? `&page=${page}` : '';
  const response = await webGet(`/sub/?searchword=${encodeURIComponent(query)}${suffix}`, {
    referer: `https://${config.assrt.domains[0]}/`,
  });
  return { ...parseAssrtSearch(response.text), domain: response.domain };
}

async function webDetail(id, domain) {
  const bucket = Math.floor(Number(id) / 1000);
  const suffixes = domain ? [`https://${domain}`, ...config.assrt.domains.filter((d) => d !== domain).map((d) => `https://${d}`)] : null;
  if (suffixes) {
    for (const base of suffixes) {
      try {
        const response = await fetchText(`${base}/xml/sub/${bucket}/${id}.xml`, {
          referer: `${base}/`,
          timeoutMs: config.assrt.timeoutMs,
        });
        if (response.ok) return parseAssrtDetail(response.text);
      } catch {
        // 换下一条线路
      }
    }
    return null;
  }
  const response = await webGet(`/xml/sub/${bucket}/${id}.xml`);
  return parseAssrtDetail(response.text);
}

// ------------------------------------------------ 搜索 ------------------------------------------------

export const cleanTitle = (title) =>
  String(title || '')
    .replace(/\s*\((\d{4})\)\s*$/, '')
    .replace(/\s*\(\d{4}[–-]\d*\)\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

// 「那条字幕是不是我要的片」：片名（含年份）里的词都出现在标题 / 版本名里才算。
export function assrtTitleScore(item, title, year) {
  const haystack = normalize(`${item.title || ''} ${item.version || ''} ${item.name || ''}`);
  const needle = normalize(`${cleanTitle(title)} ${year || ''}`);
  if (!needle) return 0;
  const tokens = needle.split(' ').filter((token) => token.length >= 2);
  if (tokens.length === 0) return 0;
  const hits = tokens.filter((token) => haystack.includes(token)).length;
  if (hits === 0) return 0;
  let score = hits / tokens.length;
  if (year && new RegExp(`(^|[^0-9])${year}([^0-9]|$)`).test(haystack)) score += 0.5;
  return score;
}

// 剧集：名字里带集号才算这一集；整季包（名字里没有集号）排在后面 ——
// 压缩包里按集挑文件（pickArchiveFile）。
export function assrtEpisodeRank(item, { season, episode }) {
  if (!episode) return 0;
  const haystack = `${item.title || ''} ${item.version || ''} ${item.filename || ''} ${item.matchedText || ''}`;
  const patterns = [];
  if (season) patterns.push(new RegExp(`S0*${season}[\\s._-]*E0*${episode}(?![0-9])`, 'i'));
  if (season) patterns.push(new RegExp(`(?<![0-9])0*${season}[xX]0*${episode}(?![0-9])`));
  patterns.push(new RegExp(`第\\s*0*${episode}\\s*[集话話]`));
  if (season) patterns.push(new RegExp(`(?<![A-Za-z0-9])S0*${season}(?![0-9])`, 'i'));
  return patterns.some((pattern) => pattern.test(haystack)) ? 0 : SEGMENTED_RANK;
}

const SEGMENTED_RANK = 1;

export async function searchAssrt(query, page = 1) {
  const key = String(query || '').trim().toLowerCase();
  if (!key) return { total: 0, items: [] };
  const mode = hasAssrtToken() ? 'api' : 'web';
  return searchCache.wrap(`assrt:${mode}:${key}:${page}`, async () => {
    try {
      if (mode === 'api') {
        const items = await apiSearch(query, page);
        return { total: items.length, items };
      }
      const result = await webSearch(query, page);
      return { total: result.total, items: result.items };
    } catch (error) {
      logSource('assrt', `搜索「${query}」失败：${error.message}`);
      throw error; // 交给上层：网络问题不该被缓存成「没结果」
    }
  });
}

// ------------------------------------------------ 取文件 ------------------------------------------------

/**
 * 一条射手（伪）字幕 → 取回来（整包就解开）。
 * API 有 token 时用详情里给的文件直链；网页则走 /download/<id>/<文件名>（302 到 file0）。
 */
export async function assrtArchive(item, refererDomain) {
  const entry = item;
  return loadArchive(`assrt:${entry.id}`, async () => {
    if (entry.filelist?.length) {
      // API：把包里的文件都取回来（一般就一两份），交给统一的解压 / 挑文件逻辑
      const files = [];
      for (const file of entry.filelist) {
        if (!file?.url) continue;
        const { fetchBinary } = await import('./net.js');
        const raw = await fetchBinary(file.url, { maxBytes: 128 * 1024 * 1024, timeoutMs: 40_000 });
        files.push({ name: String(file.f || file.filename || `${entry.id}.zip`), data: raw });
      }
      if (files.length === 0) throw new Error('射手 API 没有返回可用文件');
      return { raw: files[0].data, filename: files[0].name };
    }

    const downloadHref = assrtDownloadHref(entry);
    if (!downloadHref) throw new Error('这条字幕没有下载地址');
    const response = await webGet(downloadHref, { referer: `https://${refererDomain || config.assrt.domains[0]}/` });
    // webGet 只拿文本（确认链接活着）；真正的二进制用 fetchBinary 再取一次，
    // 它会跟着 302 去到 file0.assrt.net。
    void response;
    const { fetchBinary } = await import('./net.js');
    const base = refererDomain || config.assrt.domains[0];
    const raw = await fetchBinary(`https://${base}${downloadHref}`, {
      maxBytes: 128 * 1024 * 1024,
      timeoutMs: 40_000,
      referer: `https://${base}/sub/`,
    });
    return { raw, filename: entry.filename || decodeTail(downloadHref) || `assrt-${entry.id}.zip` };
  });
}

// ------------------------------------------------ 列表 ------------------------------------------------

const FORMAT_LABELS = [
  [/ASS|SSA|高级字幕/i, 'ASS'],
  [/SRT|SUBRIP|SUB成/i, 'SRT'],
  [/VTT|WEBVTT/i, 'VTT'],
  [/SUP|PGS/i, 'SUP'],
  [/IDX|VOB/i, 'SUB'],
];

function formatLabel(format) {
  const text = String(format || '');
  const hit = FORMAT_LABELS.find(([pattern]) => pattern.test(text));
  return hit ? hit[1] : text.replace(/\(.*\)/, '').trim();
}

// 射手（伪）的搜索结果最脏：「坏蛋联盟：闯关大行动」「Friends Sex and Games」都能混进
// 《绝命毒师》《老友记》。判定和 SubHD 一路相同（见 match.js）：片名（含中文译名）→ 年份 →
// 季号 → 集号 → 类型，对不上的一律丢；整季包、全剧合集排在正片后面。
// 射手网页上，条目的「片名」在 title 里、「版本/发布名」在 version 里、「文件名」在 filename 里；
// 详情页还能补上 matchedText（匹配视频）和 note（备注）。判定时都算进来。
export function assrtHaystack(item) {
  return [item.title, item.version, item.filename, item.matchedText]
    .filter(Boolean)
    .join(' ');
}

export async function assrtSubtitles({ type, id, baseUrl }) {
  const { imdbId, season, episode } = parseVideoId(id);
  if (!imdbId) return [];

  const meta = await addonMeta(type, imdbId);
  if (!meta || !meta.name) return [];

  const year = Number(String(meta.releaseInfo || '').match(/(19|20)\d{2}/)?.[0]) || null;
  const aliases = aliasesFor(meta.name);
  const want = { titles: [meta.name, meta.originalName].filter(Boolean), aliases, year, type, season, episode };

  // 查询顺序：英文名 → 英文名+年份 → 中文译名。
  // 和 SubHD 一样「每个查法都收」，而不是第一种有结果就停：同一部剧的各季包散落在不同
  // 关键词下（搜 Friends 只出 S01，搜「老友记 第二季」才出第二季的整季包），
  // 只看第一种查法就会漏掉 —— 剧集列表空得很。
  const queries = [
    cleanTitle(meta.name),
    year ? `${cleanTitle(meta.name)} ${year}` : '',
    ...aliases,
  ].filter((query, index, list) => query && list.indexOf(query) === index);

  const rows = [];
  const seen = new Set();
  let failures = 0;
  for (const query of queries) {
    let items;
    try {
      ({ items } = await searchAssrt(query));
    } catch (error) {
      failures += 1;
      logSource('assrt', `「${query}」搜索失败：${error.message}`);
      continue;
    }
    for (const item of items) {
      if (seen.has(item.id)) continue;
      // 射手的条目名是「片名/副标题」：片名只出现在后面（发布名里夹着别的片名）的不算
      const identity = checkIdentity({ haystack: assrtHaystack(item), headOnly: true, head: item.title || '' }, want);
      if (!identity.ok) continue;
      const rank = episodeRank({ haystack: assrtHaystack(item) }, want);
      if (rank === null) continue; // 明确是别的集
      seen.add(item.id);
      rows.push({ ...item, score: identity.score, rank });
    }
  }

  // 所有查法都失败（网络问题）才往上报：让 health.js 记账、冷落这个来源
  if (rows.length === 0 && failures === queries.length) {
    throw new Error('射手（伪）所有搜索都失败了');
  }

  rows.sort((a, b) => a.rank - b.rank || b.score - a.score || b.downloads - a.downloads);

  const wanted = rows.slice(0, config.assrt.maxResults);
  // 详情页要逐个取（网页没有批量接口）：只有搜索页没给语言 / 格式时才值得再问一次
  const details = new Map();
  if (!hasAssrtToken()) {
    for (const item of wanted.slice(0, config.assrt.detailLimit)) {
      if (item.languages && item.format) continue;
      try {
        const detail = await webDetail(item.id);
        if (detail) details.set(item.id, detail);
      } catch (error) {
        logSource('assrt', `详情 ${item.id}: ${error.message}`);
      }
    }
  }
  return wanted.map((item) => {
    const detail = details.get(item.id) || {};
    const lang = assrtLanguage(item.languages || detail.languages || '');
    const format = formatLabel(item.format || detail.format);
    // 本集精确命中（rank 0）和整季包 / 全剧合集（rank 3）都能用在这一集上；
    // 行标题要写「用户正在看的这一集」，别让人以为是整部片的字幕（SubHD 也是这样）。
    const usableHere = episode && (item.rank === 0 || item.rank >= 2);
    const whole = isWholeShow(assrtHaystack(item));
    const isEpisode = Boolean(usableHere);

    // 行标题和 SubHD 一路同规则：片名 · 第N集 · 字幕自己的名字。
    // 片名统一用中文译名（和播放器里显示的片名一致），没有就用 Cinemeta 的片名。
    const labelName = clipMiddle(aliases[0] || cleanTitle(meta.name) || cleanTitle(item.title) || '射手(伪)字幕', 48);
    const parts = [labelName];
    if (isEpisode && episodeSuffix(labelName, { season, episode })) {
      parts.push(episodeSuffix(labelName, { season, episode }));
    }
    // 副标题（发布名）：太短或和片名一样的就不占位（只有「BluRay」这种没意义）
    const subRaw = String(item.version || item.filename || detail.filename || '');
    if (subRaw.length >= 6 && normalize(subRaw) !== normalize(labelName)) {
      parts.push(clipMiddle(subRaw, 72));
    }
    const label = clipMiddle(parts.filter(Boolean).join(' · '), 132) || '射手(伪)字幕';

    // 第二行：语言 · 射手(伪) · 格式 · 来源（原创翻译 / 官方字幕）· 下载量
    const metaParts = [lang.label, '射手(伪)'];
    if (format) metaParts.push(format);
    if (item.source || detail.source) metaParts.push(item.source || detail.source);
    if (item.downloads) metaParts.push(`${item.downloads}次下载`);
    if (episode) {
      if (isWholeShow(assrtHaystack(item))) metaParts.push('整季合集');
      else if (whole) metaParts.push('整季合集');
      else if (item.episode) metaParts.push(episodeSuffix(labelName, { season, episode }) || `第${episode}集`);
      else if (seasonInfo(assrtHaystack(item)) !== null) metaParts.push('整季合集');
      else metaParts.push('整部/整剧');
    }

    // 影视文件是 srt / ass / sup 时就按那个扩展名发；网页不知道格式时先按 srt
    const ext = /SUP|PGS/i.test(item.format || detail.format || '') ? 'sup' : format === 'ASS' ? 'ass' : 'srt';

    return {
      id: `${clipMiddle(label, 60)} · ${lang.label} · assrt-${item.id}`,
      // 走自己的路由：点开才去射手取（压缩包里按语言挑一份），编码也在这里统一成 UTF-8
      url: `${baseUrl}/assrt/${item.id}.${ext}?lang=${encodeURIComponent(lang.code)}${
        season ? `&s=${season}` : ''
      }${episode ? `&e=${episode}` : ''}`,
      lang: metaParts.filter(Boolean).join(' · '),
      label,
    };
  });
}

// /assrt/<id>.<ext> 那条路要用：列表里没把下载地址写进 url（太长），点开时按编号再查一次。
// 有 token 走详情接口，没有就把编号塞进搜索框（站点会直接跳到那条详情页）。
export async function assrtById(id) {
  const key = `byid:${hasAssrtToken() ? 'api' : 'web'}:${id}`;
  return detailCache.wrap(key, async () => {
    if (hasAssrtToken()) {
      const detail = await apiDetail(id);
      return {
        id: String(id),
        filelist: detail.filelist,
        languages: detail.languages,
        format: detail.format,
        title: detail.name,
        source: '',
        filename: '',
        downloadHref: '',
      };
    }
    const result = await webSearch(String(id));
    const item = result.items.find((candidate) => candidate.id === String(id));
    if (item) {
      const detail = await webDetail(id, result.domain).catch(() => null);
      return { ...item, ...(detail || {}), domain: result.domain };
    }
    // 搜索页没列出来（编号被当成名字搜）：直接按编号拼详情页地址
    const detail = await webDetail(id, result.domain).catch(() => null);
    if (!detail) throw new Error(`射手（伪）上找不到字幕 ${id}`);
    return { id: String(id), ...detail, domain: result.domain };
  });
}

function decodeTail(href) {
  try {
    return decodeURIComponent(String(href).split('/').pop() || '');
  } catch {
    return String(href).split('/').pop() || '';
  }
}

export { webGet, extOfUrl };

// ------------------------------------------------ 最新字幕 ------------------------------------------------

// 最新字幕列表页（/xml/list/sub/）的条目名和搜索页不一样，是一整串文件名：
//   「First Communion 2025/First.Communion.2025.1080p.WEBRip.x264-CBFM」
//   「City of God: The Fight Rages On S02E01/上帝之城：斗争蔓延/City.of.God….mkv」
// 前两段通常是「中文名/英文名」，也可能是「英文名/中文名」。名字挑「像片名的那一段」，
// 年份和 SxxExx 从整串里找。
export function parseAssrtListItem(rawTitle) {
  const raw = String(rawTitle || '').trim();
  const segments = raw
    .split(/\s*\/\s*/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  const releaseLike = (segment) =>
    /\.(mkv|mp4|avi|ts|m2ts|rmvb|web-?dl|webrip|bluray|bdrip|hdtv|remux|h\.?26[45]|x26[45])\b|[.]\d{3,4}p[.]/i.test(
      segment.replace(/\s+/g, '.'),
    ) || /\.[A-Za-z0-9]{1,4}$/.test(segment);

  let title = '';
  for (const segment of segments) {
    if (releaseLike(segment)) continue;
    title = segment;
    break;
  }
  if (!title) title = String(raw).split(/\.(mkv|mp4|avi|ts)/i)[0];

  // 「Dune.Part.Two.2024」→「Dune Part Two」
  title = title
    .replace(/\.(?=[A-Za-z])/g, ' ')
    .replace(/\s*(S\d{1,2}E\d{1,3}.*|第\s*\d+\s*集|[.\s]\d{3,4}p.*)$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // 标题里以空格结尾的年份（「First Communion 2025」）算年份，但不要留在片名里
  const yearInTitle = title.match(/\s(19|20)\d{2}$/)?.[0];
  if (yearInTitle) title = title.slice(0, -yearInTitle.length).trim();

  const year = Number((raw.match(/(?<!\d)(19|20)\d{2}(?!\d)/) || [])[0]) || null;
  const episode = Number((raw.match(/S\d{1,2}E(\d{1,3})/i) || [])[1] || 0) || null;
  const season = Number((raw.match(/S(\d{1,2})E\d{1,3}/i) || [])[1] || 0) || null;
  return { title, year, season, episode, full: raw };
}

/** 最新字幕列表页 → 和搜索页一样的 items */
export function parseAssrtFeed(html) {
  return parseAssrtSearch(html);
}

export async function latestAssrt(page = 1) {
  const suffix = page > 1 ? `?page=${page}` : '';
  return searchCache.wrap(`assrt:latest:${page}`, async () => {
    try {
      const response = await webGet(`/xml/list/sub/${suffix}`, { referer: `https://${config.assrt.domains[0]}/` });
      return { ...parseAssrtFeed(response.text), domain: response.domain };
    } catch (error) {
      logSource('assrt', `最新字幕：${error.message}`);
      return { total: 0, page: 1, pages: 1, items: [] };
    }
  });
}

// 列表里的条目名往往写着「片名 原名 (年份)」：交给 Cinemeta 搜一下换成 tt 编号，
// 这样点进去就是正常的影片页（否则 Stremio 只会显示一条搜不到元数据的占位）。
export function splitAssrtTitle(title) {
  return parseAssrtListItem(title);
}
