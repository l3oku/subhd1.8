// 迅雷字幕（迅雷看看 / 迅雷影音用的那套字幕库）。
//
// 接口：https://api-shoulei-ssl.xunlei.com/oracle/subtitle?name=<片名>
//   返回 { code: 0, data: [ { url, ext, name, simple_name, languages: ['简体'], duration, ... } ] }
//   url 就是字幕文件的直链（subtitle.v.geilijiasu.com），不需要登录、不需要额外握手。
//
// 它只认「片名」：中文名命中率高，英文名经常一条都对不上（「Dune」→ 0 条），
// 所以先按名字查，查不到再换年份 / 去标点的写法多试几次；结果按「文件」去重之后
// 才进列表，免得同一个文件铺满一整屏。
import { config } from './config.js';
import { TtlCache } from './cache.js';
import { fetchText, logSource } from './net.js';
import { isProxyEnabled, proxyFetchText } from './proxy-cf.js';
import { parseVideoId } from './parse.js';
import { clipMiddle, episodeSuffix } from './label.js';
import { addonMeta } from './meta.js';
import { checkIdentity, cleanTitle, episodeInfo, episodeRank, firstYear, isWholeShow, normalize, seasonInfo } from './match.js';
import { aliasesFor, englishFor } from './aliases.js';

export const isThunderEnabled = () => true;

const searchCache = new TtlCache({ ttlMs: 10 * 60 * 1000, maxEntries: 300 });

// 「简体」「繁体」「中英」「eng / chi / zht」→ 给人看的语言名 + Stremio 的 lang 代码
const LANG_RULES = [
  [/中英|英中|双语|雙語|简英|繁英|简繁/, '中英双语', 'zh'],
  [/简|chs|zh-cn|zh-hans|simplified|chi-?cn/i, '简体', 'zh-Hans'],
  [/繁|cht|zh-tw|zh-hant|traditional|big5/i, '繁体', 'zh-Hant'],
  [/英语|英語|english|(^|[^a-z])(eng|en)([^a-z]|$)/i, '英语', 'en'],
  [/日语|日語|japanese|(^|[^a-z])(jpn|ja|jp)([^a-z]|$)/i, '日语', 'ja'],
  [/韩语|韓語|korean|(^|[^a-z])(kor|kr)([^a-z]|$)/i, '韩语', 'ko'],
  [/zho|chi|中文|字幕/i, '简体', 'zh-Hans'],
];

export function thunderLanguage(languages) {
  const tags = (Array.isArray(languages) ? languages : [languages])
    .map((tag) => String(tag || '').trim())
    .filter(Boolean);
  const labels = [];
  const codes = [];

  for (const tag of tags) {
    for (const [pattern, label, lang] of LANG_RULES) {
      if (!pattern.test(tag)) continue;
      if (!labels.includes(label)) labels.push(label);
      if (!codes.includes(lang)) codes.push(lang);
      break;
    }
  }
  // 中英双语的包里简繁都有，第二行只写一个「中英双语」，别写成「中英双语/简体」
  const ordered = labels.includes('中英双语') ? labels.filter((label) => label === '中英双语') : labels;
  const shown = ordered.length > 0 ? ordered.join('/') : '简体';
  // Stremio 的 lang 字段只拿来做排序 / 默认选择：只有一种语言时如实报，中英双语按简体中文报
  const only = codes.length === 1 ? codes[0] : null;
  const stremioLang = only && ['en', 'ja', 'ko', 'zh-Hant'].includes(only) ? only : 'zh';
  return { label: shown, code: stremioLang };
}

// ------------------------------------------------ 片名 ------------------------------------------------

// Stremio 送来的是 id（tt…），片名得问 Cinemeta。它给的是英文原名（Dune: Part Two），
// 但迅雷的字幕库是按中文名建的（搜 Interstellar 有 46 条，搜中文名也一样能命中，
// 而 Dune 这种 0 条）。所以查询时英文名和中文译名都试，见 THUNDER_ALIASES。

export function titleVariants(title, year) {
  const base = cleanTitle(title);
  if (!base) return [];
  const variants = [];
  const push = (value) => {
    const text = String(value || '').trim();
    if (text && !variants.includes(text)) variants.push(text);
  };

  const ascii = base.replace(/[:：]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  push(base);
  if (year) push(`${base} ${year}`);
  if (ascii !== base) push(ascii);
  if (year && ascii !== base) push(`${ascii} ${year}`);
  return variants.slice(0, 4);
}

// 迅雷接口 http / https 都能用，而且两者在不同网络下的耗时差别很大（境外机房 https 的
// 跨境 TLS 经常被掐，http 反而快）。所以两个协议同时发，谁先给出有效结果就用谁 ——
// 不写死某一个，也不多做一次串行重试。
// TIP: THUNDER_API_BASE 里写了 http:// 或 https:// 时，就只走那一个（想固定下来用）。
function thunderBases() {
  const base = String(config.thunder.apiBase || '').replace(/\/+$/, '');
  if (/^https?:\/\//.test(base)) {
    const alt = base.replace(/^https:\/\//, 'http://').replace(/^http:\/\//, 'https://');
    return [base, alt];
  }
  return [`https://${base}`, `http://${base}`];
}

async function queryOne(base, name) {
  const url = `${base}/oracle/subtitle?name=${encodeURIComponent(name)}`;
  // 配了 Cloudflare 出口代理就走代理：Vercel 的机房连迅雷经常 Connect Timeout，
  // 而 CF 香港节点实测稳定（见 proxy-cf.js 的说明）。
  if (isProxyEnabled()) {
    const viaProxy = await proxyFetchText(url, { timeoutMs: config.thunder.timeoutMs + 3000, accept: 'application/json' });
    if (!viaProxy.ok) {
      logSource('thunder', `代理搜索 HTTP ${viaProxy.status}: ${name}`);
      return [];
    }
    try {
      const body = JSON.parse(viaProxy.text);
      if (!body || Number(body.code) !== 0 || !Array.isArray(body.data)) return [];
      return body.data.filter((item) => item && typeof item.url === 'string' && /^https?:\/\//.test(item.url));
    } catch {
      return [];
    }
  }
  const response = await fetchText(url, {
    accept: 'application/json, text/plain, */*',
    acceptLanguage: 'zh-CN,zh;q=0.9',
    referer: 'https://www.xunlei.com/',
    timeoutMs: config.thunder.timeoutMs,
  });
  if (!response.ok) {
    logSource('thunder', `搜索 HTTP ${response.status}: ${name}`);
    return [];
  }
  let body;
  try {
    body = JSON.parse(response.text);
  } catch {
    return [];
  }
  if (!body || Number(body.code) !== 0 || !Array.isArray(body.data)) return [];
  return body.data.filter((item) => item && typeof item.url === 'string' && /^https?:\/\//.test(item.url));
}

// 两个协议并发；一个挂了不影响另一个。都失败才往上报（交给 health.js 记账）。
async function queryThunder(name) {
  const bases = thunderBases();
  const settled = await Promise.allSettled(bases.map((base) => queryOne(base, name)));
  const ok = settled.filter((item) => item.status === 'fulfilled').map((item) => item.value);
  if (ok.length > 0) return ok.sort((a, b) => b.length - a.length)[0];
  const first = settled.find((item) => item.status === 'rejected');
  throw first ? first.reason : new Error('迅雷接口没有返回');
}

export async function searchThunder(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return [];
  const cached = searchCache.get(`thunder:${key}`);
  if (cached) return cached;
  // 失败直接抛出去（交给上层的健康检查 / 超时兜底），不把「网络不通」缓存成「没结果」
  const items = await queryThunder(name);
  searchCache.set(`thunder:${key}`, items);
  return items;
}

/**
 * 「这个词搜不到」时的备用搜法：迅雷的字幕库按条目名建索引，中文片名常常搜不到
 * （实搜「奥德赛」0 条、「The Odyssey」57 条，而且那 57 条的文件名全是「奥德赛.srt」）。
 * 所以中文没结果时，用 Cinemeta 拿到英文原名 / 官方名再搜一遍；反过来也一样。
 */
export async function thunderSearchFallback(keyword) {
  const raw = String(keyword || '').trim();
  if (!raw) return [];

  // 迅雷的索引是「条目名」：中文片名常常搜不到（「奥德赛」0 条），而它的英文名一搜就是
  // 一大堆中文文件（「The Odyssey」57 条，文件名全是「奥德赛.srt」）。所以中文没结果时，
  // 按译名表反查英文原名再搜一次。
  const candidates = new Set();
  for (const english of englishFor(raw)) {
    // 英文首字母大写：迅雷索引区分大小写（「the odyssey」搜不到，「The Odyssey」可以）
    candidates.add(english.replace(/\b\w/g, (c) => c.toUpperCase()));
  }
  // 译名表没收录时，问一下 Cinemeta（中文能查到就拿它的英文名）
  if (candidates.size === 0) {
    try {
      const { searchMeta } = await import('./meta.js');
      const hit = await searchMeta('movie', raw);
      for (const name of [hit?.name, hit?.originalName].filter(Boolean)) candidates.add(name);
    } catch {
      // 查不到就放弃
    }
  }

  candidates.delete(raw);
  const tries = [...candidates].filter(Boolean).slice(0, 2);
  if (tries.length === 0) return [];

  const results = await Promise.allSettled(tries.map((term) => searchThunder(term)));
  const merged = new Map();
  for (const item of results) {
    if (item.status !== 'fulfilled') continue;
    for (const row of item.value) {
      const key = row.url || row.gcid;
      if (!merged.has(key)) merged.set(key, row);
    }
  }
  logSource('thunder', `「${raw}」没结果，改用 ${JSON.stringify(tries)} 搜到 ${merged.size} 条`);
  return [...merged.values()];
}

// ------------------------------------------------ 拆名字 ------------------------------------------------

const SIMPLE_NAME_RE = /^(\S*?)\s*\[([A-Za-z0-9]+)\]\s*(.*?)\s*(?:\((\d{4})\))?$/;

// simple_name 形如「简体[SRT]沙丘2(2024)」：语言、格式、作品名、年份都在里面，
// 比文件名好读。拆不出来就整串当作品名。
export function parseSimpleName(simpleName) {
  const match = String(simpleName || '').match(SIMPLE_NAME_RE);
  if (!match) return { language: '', ext: '', work: String(simpleName || '').trim(), year: null };
  return {
    language: match[1].trim(),
    ext: match[2].toUpperCase(),
    work: match[3].trim(),
    year: match[4] ? Number(match[4]) : null,
  };
}

const RAW_EXT_RE = /\.([A-Za-z0-9]{1,4})$/;

export function extOf(item) {
  const parsed = parseSimpleName(item.simple_name);
  const fromName = (String(item.name || '').match(RAW_EXT_RE) || [])[1];
  const ext = String(item.ext || fromName || parsed.ext || 'srt').toLowerCase();
  return ['srt', 'ass', 'ssa', 'vtt', 'sup'].includes(ext) ? ext : 'srt';
}

// 老测试直接从这里拿 cleanTitle，转发一下（实现已移到 match.js）
export { cleanTitle };

export const EXT_FORMAT = { srt: 'SRT', ass: 'ASS', ssa: 'ASS', vtt: 'VTT', sup: 'SUP' };

// 「这条字幕是不是我要看的那部片子」—— 判定逻辑和 SubHD 那一路对齐（见 match.js）：
// 片名（含中文译名）→ 年份 → 季号 → 集号，任何一环对不上就不要。
// 迅雷每条结果都带一个 simple_name（「简体[SRT]The Greatest」），它里面的片名是**搜索
// 时用的关键词**、不是这条字幕自己的名字 —— 拼进判定文本的话，搜什么都会「对上」，
// Sia 的 MV、苹果广告全都能过。所以只留语言/格式标记，片名以 fileName 为准。
// 判定用的文本：文件名 + simple_name 里的片名。
// 迅雷每条结果都带 simple_name（「简体[SRT]奥德赛」），那截片名是**站点自己给这条字幕定的片名**，
// 比文件名可靠 —— 57 条「The Odyssey」里有 35 条只有中文片名（奥德赛.srt），
// 以前只看文件名，这些中文条目就全被判成「片名对不上」丢掉了。
// 语言/格式标记（简体、SRT）不进判定文本，避免把片名顶到后面去。
export function thunderHaystack(item) {
  const parsed = parseSimpleName(item.simple_name);
  const work = parsed.work && parsed.work !== item.name ? parsed.work : '';
  return [String(item.name || ''), work].filter(Boolean).join(' ');
}

/** 条目「自己的作品名」：simple_name 里那截片名（只用于显示，不参与判定） */
export function thunderWorkName(item) {
  return parseSimpleName(item.simple_name).work || '';
}

/** @returns {number} 0 = 不是这部片；否则越大越靠前 */
export function titleScore(item, title, year, extra = {}) {
  const result = checkIdentity(
    { haystack: thunderHaystack(item), fileName: extra.fileName || '' },
    {
      titles: [title, ...(extra.titles || [])].filter(Boolean),
      aliases: extra.aliases || [],
      year,
      type: extra.type || 'movie',
      season: extra.season ?? null,
      episode: extra.episode ?? null,
      needType: extra.needType !== false,
    },
  );
  if (!result.ok) return 0;
  let score = result.score;
  // 整部片的「标题和片名一模一样」（沙丘2.srt / 沙丘2.ass）是校对过的主字幕，排前面
  const bare = normalize(String(item.name || '')).replace(/\.[a-z0-9]{2,4}$/, '');
  if (bare && normalize(cleanTitle(title)) === bare) score += 0.4;
  return score;
}

// 「S01E04」「1x04」「第4集」都认；返回 true 才算「就是这一集」。
export function isWantedEpisode(item, { season, episode }) {
  if (!episode) return false;
  const info = episodeInfo(`${item.name || ''} ${item.simple_name || ''}`);
  if (info.pack || info.episode === null) return false;
  return info.episode === Number(episode) && (info.season === null || !season || info.season === Number(season));
}

// ------------------------------------------------ 列表 ------------------------------------------------

/** 一条迅雷结果 → 统一的 entry（见 addon.js 的 subtitleTrack） */
export function thunderEntry(item, wanted) {
  const parsed = parseSimpleName(item.simple_name);
  const lang = thunderLanguage(item.languages);
  const ext = extOf(item);
  // 行标题写「中文译名（能和客户端里的片名对上）」排第一；没有译名时用条目自己的名字
  const alias = (wanted.aliases || []).find((name) => String(item.name || '').toLowerCase().includes(name.toLowerCase()));
  // 条目自己没写作品名时，不拿 Cinemeta 的片名去顶（否则别的片子的文件也会挂上本片名）
  // 行标题的片名：中文译名（有就用，和客户端里显示的片名一致）→ 条目自己的作品名 → 文件名
  const workName =
    (wanted.aliases || [])[0] || thunderWorkName(item) || String(item.name || '').replace(/\.[A-Za-z0-9]{1,4}$/, '') || '迅雷字幕';
  const url = String(item.url || '').replace(/^http:\/\//, 'https://');
  const isEpisode = isWantedEpisode(item, wanted);

  return {
    source: 'thunder',
    sourceName: '迅雷',
    sid: String(item.gcid || item.cid || url).replace(/[^A-Za-z0-9]/g, '').slice(0, 24),
    title: `${workName}${parsed.year ? ` (${parsed.year})` : ''}`,
    workName,
    filename: String(item.name || '').replace(/\s*\(\d+\)(\.[A-Za-z0-9]{1,4})$/, '$1'),
    fileUrl: url,
    languages: lang.label.split('/'),
    formats: EXT_FORMAT[ext] ? [EXT_FORMAT[ext]] : [],
    season: isEpisode ? wanted.season : null,
    episode: isEpisode ? wanted.episode : null,
    pack: episodeInfo(thunderHaystack(item)).pack,
    haystack: thunderHaystack(item),
    durationMs: Number(item.duration) || 0,
  };
}

/** 一条迅雷结果 → Stremio 的字幕轨道 */
export function thunderTrack(entry, { baseUrl, season, episode }) {
  const lang = thunderLanguage(entry.languages);
  const format = entry.formats[0] || 'SRT';
  const labelName = clipMiddle(entry.workName || '迅雷字幕', 48);

  // 行标题和 SubHD 那一路同规则：片名 · 第N集 · 字幕自己的名字
  // （没有集号时不要留一个空段，否则会出现「沙丘2 ·  · 文件名」这种双分隔符）
  const parts = [labelName];
  if (episodeSuffix(labelName, { season: entry.season, episode: entry.episode })) {
    parts.push(episodeSuffix(labelName, { season: entry.season, episode: entry.episode }));
  }
  if (entry.filename && entry.filename !== entry.workName) parts.push(clipMiddle(entry.filename, 72));
  const label = clipMiddle(parts.filter(Boolean).join(' · '), 132) || '迅雷字幕';

  // 第二行：语言 · 迅雷 · 格式 · 集号 / 整季合集 / 整部剧
  const meta = [lang.label, '迅雷', format];
  if (episode) {
    if (isWholeShow(entry.haystack || '') || /全\s*\d+\s*[季集]|Complete\s+Series/i.test(entry.filename || '')) meta.push('整季合集');
    else if (entry.episode) meta.push(episodeSuffix(labelName, { season, episode }) || `第${episode}集`);
    else if (seasonInfo(entry.haystack || '') !== null) meta.push('整季合集');
    else meta.push('整部/整剧');
  }

  // 点开时用的地址：走插件自己的 /thunder/<url64>，服务器替用户去 CDN 取
  //（Vercel 上 CDN 常常连不上、取下来还要统一转 UTF-8，见 files.js）。
  rememberThunder(entry.sid, entry);
  const url = `${baseUrl}/thunder/${base64url(entry.fileUrl)}.${(entry.formats[0] || 'srt').toLowerCase()}`;

  return {
    id: `${clipMiddle(label, 60)} · ${lang.label} · thunder-${entry.sid}`,
    url,
    lang: meta.join(' · '),
    label,
  };
}

// 点开时才需要「这条字幕叫什么、是哪一集」，别再搜一遍：列表生成时顺手记下
const trackItems = new TtlCache({ ttlMs: 30 * 60 * 1000, maxEntries: 2000 });

export function rememberThunder(sid, entry) {
  trackItems.set(`thunder:${sid}`, entry);
}

export function thunderItem(sid) {
  return trackItems.get(`thunder:${sid}`) || null;
}

export function base64url(value) {
  return Buffer.from(String(value), 'utf8').toString('base64url');
}

export function fromBase64url(value) {
  try {
    return Buffer.from(String(value), 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

export async function thunderSubtitles({ type, id, baseUrl }) {
  const { imdbId, season, episode } = parseVideoId(id);
  if (!imdbId) return [];

  const meta = await addonMeta(type, imdbId);
  if (!meta || !meta.name) {
    logSource('thunder', `Cinemeta 里没有 ${id}`);
    return [];
  }

  const wanted = {
    type,
    title: meta.name,
    year: firstYear(meta.releaseInfo),
    season,
    episode,
    // 中文译名：既用来搜（「沙特阿拉伯」这种英文名搜不到的），也用来认出中文条目
    aliases: aliasesFor(meta.name),
  };

  const names = [
    ...titleVariants(meta.name, wanted.year),
    // 中文译名优先于「只写片名」：迅雷的字幕库按中文名建索引，Dune 搜不到，沙丘一搜一大把
    ...(wanted.aliases.length > 0 && wanted.year ? wanted.aliases.map((alias) => `${alias} ${wanted.year}`) : []),
    ...(meta.originalName && meta.originalName !== meta.name ? titleVariants(meta.originalName, wanted.year) : []),
    ...wanted.aliases,
  ];

  const picked = new Map();
  const collect = (items) => {
    let matched = 0;
    for (const item of items) {
      const url = String(item.url || '');
      if (!url || picked.has(url)) continue;
      // 判定完全走 match.js：片名（英文 + 中文译名）→ 年份 → 季 → 类型，和 SubHD 一个标准
      const haystack = thunderHaystack(item);
      const score = titleScore(item, meta.name, wanted.year, {
        titles: wanted.aliases,
        type,
        season,
        episode,
        // 迅雷的条目名就是文件名：「Friends.Lovers.1999」这种以片名开头、后面接别的
        // 英文词的，是另一部片子（《老友记》的条目后面接的是 S01E05 / 第一季）。
        fileName: item.name || '',
      });
      if (score <= 0) continue;
      if (episodeRank({ haystack }, wanted) === null) continue; // 明确是别的集，直接不要
      picked.set(url, { item, score });
      matched += 1;
    }
    return matched;
  };

  const byYear = names.filter((name) => wanted.year && name.endsWith(String(wanted.year)));
  const plain = names.filter((name) => !byYear.includes(name));

  // 以前是「先查英文名，没结果再查中文译名」一个个串着来 —— 网络一慢，时间就翻倍。
  // 现在所有候选名（英文名、带年份、中文译名）同时发，谁先回来先收谁，收完再判定。
  // 一次请求取前三个最有希望的，别把接口打爆。
  // 迅雷接口对「不带年份」的名字经常返回 0 条（Wednesday → 0，Wednesday 2022 → 10 条），
  // 所以带年份的写法优先，而且中文译名、原名的各种写法都要发出去。最多 4 个并发。
  const queries = [...new Set([...byYear, ...plain])].slice(0, 4);
  let failures = 0;
  const tasks = queries.map((name) =>
    searchThunder(name).then(
      (items) => ({ name, items }),
      () => {
        failures += 1;
        return null;
      },
    ),
  );
  // 并行等所有写法：谁先回来先收，但**空结果不算数**（空可能是接口对该写法返回空，
  // 别的写法有）；收够了（>= 上限的一半）就提前结束。
  const pending = [...tasks];
  let found = 0;
  while (pending.length > 0) {
    const done = await Promise.race(pending);
    pending.splice(pending.indexOf(done), 1);
    if (!done) continue;
    const before = picked.size;
    collect(done.items);
    found += picked.size - before;
    if (found >= Math.ceil(config.thunder.maxResults / 2)) break;
  }
  await Promise.allSettled(tasks);
  // 全部失败（网络）才往上报
  if (failures === queries.length && queries.length > 0) {
    throw new Error('迅雷所有搜索都失败了');
  }

  // 排序：本集精确命中 → 没写集号（整部/整剧）→ 整季包；同档按身份分
  const rows = [...picked.values()].sort(
    (a, b) =>
      episodeRank({ haystack: thunderHaystack(a.item) }, wanted) -
        episodeRank({ haystack: thunderHaystack(b.item) }, wanted) || b.score - a.score,
  );

  const entries = rows.slice(0, config.thunder.maxResults).map(({ item }) => thunderEntry(item, wanted));
  return entries.map((entry) => thunderTrack(entry, { baseUrl, season, episode }));
}
