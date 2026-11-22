// 迅雷 / 射手（伪）共用的「这条字幕到底是不是我要的那部片、那一集」判定。
//
// 照着 SubHD 那一路的思路来：
//   1. 身份（对应 SubHD 的「作品页 imdb 对不上就不要」）：片名要出现、年份要对得上、
//      电影不要剧集字幕。
//   2. 季（对应 splitWorksBySeason）：名字里写了季号就必须是这一季；整季包、全剧合集留着，
//      但排在正片后面。
//   3. 集（对应 detectEpisodeInText）：写了集号就必须对得上，明确是别的集的直接丢掉。
//
// 只有一条「聪明」规则：文件/标题以英文片名打头、紧接着又是另一个英文词时，那是另一部片
// （Friends.Lovers.1999 ≠ 老友记，Friends.S01E05 = 老友记）。

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;

export const normalize = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^\p{Script=Han}a-z0-9]+/gu, ' ')
    .trim();

export function cleanTitle(title) {
  return String(title || '')
    .replace(/\s*\((\d{4})\)\s*$/, '')
    .replace(/\s*\(\d{4}[–-]\d*\)\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function firstYear(releaseInfo) {
  return Number(String(releaseInfo || '').match(/(19|20)\d{2}/)?.[0]) || null;
}

// 片名里的虚词不算关键词；中文的「第几季 / 全N集」也不算
const STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'and', 'part', 'parts', 'vol', 'chapter', 'season']);
const CJK_NOISE = /第\s*[零一二三四五六七八九十百千\d]+\s*[季集部]|全\s*\d+\s*集|合集|系列|花絮|幕后/g;

// 通用词：单独出现证明不了「就是这部片」（《绝命毒师》的条目里到处是 bad）
const GENERIC_WORDS = new Set([
  'bad', 'good', 'man', 'men', 'woman', 'women', 'love', 'life', 'time', 'times', 'day', 'days',
  'night', 'dark', 'black', 'white', 'red', 'blue', 'green', 'war', 'world', 'story', 'stories',
  'last', 'first', 'new', 'old', 'big', 'little', 'lost', 'game', 'games', 'home', 'house',
  'city', 'girl', 'girls', 'boy', 'boys', 'king', 'queen', 'star', 'stars', 'fire', 'water',
  'dead', 'death', 'live', 'kill', 'killer', 'money', 'summer', 'winter', 'spring', 'fall',
  'one', 'two', 'three', 'final', 'end', 'begins', 'returns', 'rising', 'legacy', 'super',
  'more', 'less', 'high', 'low', 'road', 'away', 'back', 'up', 'out',
]);

export function titleTokens(title) {
  return normalize(cleanTitle(title).replace(CJK_NOISE, ' '))
    .split(' ')
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

export function yearsIn(text) {
  return new Set(String(text || '').match(/(?<!\d)(19|20)\d{2}(?!\d)/g) || []);
}

// 「S01E04 / 1x04 / 第4集 / E04」→ 集号；范围（S01E01-08、全8集）返回 pack: true
const EPISODE_RANGE_RE =
  /S\d{1,2}\s*E\s*\d{1,3}\s*[-–~至]\s*E?\d{1,3}|第\s*\d{1,3}\s*[-–~至]\s*\d{1,3}\s*集|全\s*\d+\s*集/i;
const EPISODE_PATTERNS = [
  // S01E03 / S01.E03 / S01 E03 / S01-E03（迅雷里有大量「S01.E03」这种带点或空格的写法）
  /S(\d{1,2})[\s._-]*E(\d{1,3})(?![\d-])/i,
  /(?<![A-Za-z0-9])(\d{1,2})\s*[xX]\s*(\d{1,3})(?![\d-])/,
  /第\s*(\d{1,3})\s*集/,
  /(?<![A-Za-z])E(?:P|PISODE)?\.?\s*(\d{1,3})(?![\d-])/i,
];

// 「权力的游戏2.ass」「沙丘2」这种：中文片名后面直接跟数字。
// 剧集里这几乎都是集号（权力的游戏2 = 第2集），电影里是续集序号（沙丘2）—— 由调用方按类型决定。
const CJK_TRAILING_NUMBER_RE = /([\u3400-\u4dbf\u4e00-\u9fff]{2,})[\s._-]*(\d{1,3})(?![\d.]\s*(?:\d{3,4}p|[A-Za-z]{2,}))/;

export function cjkTrailingNumber(text) {
  const match = String(text || '').match(CJK_TRAILING_NUMBER_RE);
  return match ? { title: match[1], number: Number(match[2]) } : null;
}

export function episodeInfo(text) {
  const source = String(text || '');
  if (EPISODE_RANGE_RE.test(source)) return { season: null, episode: null, pack: true };
  for (const [index, pattern] of EPISODE_PATTERNS.entries()) {
    const match = source.match(pattern);
    if (!match) continue;
    return {
      season: index <= 1 ? Number(match[1]) : null,
      episode: Number(match[index <= 1 ? 2 : 1]) || null,
      pack: false,
    };
  }
  return { season: null, episode: null, pack: false };
}

// 「S03」这种单独的季号（后面不跟 E 集号，那样由 SEASON_WITH_EPISODE_RE 处理）
const SEASON_PATTERNS = [
  /第\s*([零一二三四五六七八九十百千\d]+)\s*季/,
  /(?<![A-Za-z0-9])S(\d{1,2})(?![\dE])/i,
  /season\s*(\d{1,2})/i,
];
const SEASON_WITH_EPISODE_RE = /(?<![A-Za-z0-9])S(\d{1,2})[\s._-]*E\d{1,3}/i;

const CHINESE_DIGITS = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function chineseNumber(text) {
  const value = String(text || '').trim();
  if (/^\d+$/.test(value)) return Number(value);
  let total = 0;
  let current = 0;
  for (const char of value) {
    if (char === '十') {
      total += (current || 1) * 10;
      current = 0;
    } else if (char === '百') {
      total += (current || 1) * 100;
      current = 0;
    } else if (CHINESE_DIGITS[char] !== undefined) {
      current = CHINESE_DIGITS[char];
    }
  }
  return total + current;
}

// 「第3季」「第三季」「S03E01」「Season 3」→ 季号
export function seasonInfo(text) {
  const source = String(text || '');
  const withEpisode = source.match(SEASON_WITH_EPISODE_RE);
  if (withEpisode) return Number(withEpisode[1]);
  for (const pattern of SEASON_PATTERNS) {
    const match = source.match(pattern);
    if (match) return chineseNumber(match[1]);
  }
  return null;
}

// 不是影视字幕的东西：音乐 MV / 歌词、演讲、球赛、纪录片短片、油管视频……迅雷的字幕库里
// 这类东西很多（搜 The Greatest 能搜出 Sia 的 MV、MLB 集锦、贝索斯演讲）。宁可不显示，
// 也别让用户在一堆无关的东西里找。
const NOT_FILM_RE =
  /\b(AV\d{4,}|BV\w{8,}|P\d)\b|歌词|lyrics|cover by|official video|music video|\bMV\b|卡拉OK|ktv|MLB|NBA|NFL|UFC|highlight|集锦|演讲|speech|ted ?x?\b|conference|访谈节目|podcast|vlog|shorts?\b|trailer|预告片/i;

export const looksNotFilm = (text) => NOT_FILM_RE.test(String(text || ''));

const EXTRA_RE =
  /花絮|幕后|预告|制作特辑|访谈|解说|演职员表|删减|彩蛋|extras?|behind[ ._-]?the[ ._-]?scenes|trailer|featurette/i;

export const looksExtra = (text) => EXTRA_RE.test(String(text || ''));

// 整季合集 / 全剧合集
const WHOLE_SHOW_RE =
  /S\d{1,2}\s*[-–~]\s*S?\d{1,2}|第\s*\d+\s*[-–~]\s*\d+\s*季|全\s*\d+\s*[季集]|全集|合集|Complete\s+(Series|Collection)/i;
export const isWholeShow = (text) => WHOLE_SHOW_RE.test(String(text || ''));

// 在「词边界」上找关键词（bad 不该命中 Bad.Language）
function hasToken(haystack, token) {
  if (token.length < 2) return false;
  let from = 0;
  while (from <= haystack.length) {
    const index = haystack.indexOf(token, from);
    if (index < 0) return false;
    const before = index === 0 ? '' : haystack[index - 1];
    const after = index + token.length >= haystack.length ? '' : haystack[index + token.length];
    const boundary = (value) => value === '' || value === ' ' || !/[a-z0-9]/.test(value);
    if (boundary(before) && boundary(after)) return true;
    from = index + 1;
  }
  return false;
}

// 片名吻合度（0 = 不吻合）。中文整串（两字短名要有边界），英文按词边界。
function matchTitle(title, haystack) {
  const tokens = titleTokens(title);
  if (tokens.length === 0) return 0;

  if (CJK_RE.test(title) && tokens.every((token) => CJK_RE.test(token))) {
    const needle = normalize(cleanTitle(title).replace(CJK_NOISE, ' '));
    if (!needle) return 0;
    const index = haystack.indexOf(needle);
    if (index < 0) return 0;
    if (needle.length <= 2) {
      const before = index === 0 ? ' ' : haystack[index - 1];
      const after = index + needle.length >= haystack.length ? ' ' : haystack[index + needle.length];
      if (before !== ' ' || after !== ' ') return 0;
    }
    return 1 + needle.length * 0.001;
  }

  // 英文 / 混合片名：按「完整词序」比对（不再把 the 当停用词去掉 —— 否则
  // The Greatest 只剩 greatest，「50 of the greatest MOVIE QUOTES」也会被当成命中）。
  // 片名必须是名称段的开头：前面只能是季/集/年份标记或什么都没有。
  const words = haystack.split(' ').filter(Boolean);
  const needle = normalize(cleanTitle(title.replace(CJK_NOISE, ' ')))
    .split(' ')
    .filter(Boolean);
  if (needle.length === 0) return 0;
  // 全是 bad / man 这类通用词的片名，单独出现证明不了什么
  if (!needle.some((token) => !GENERIC_WORDS.has(token))) return 0;

  for (let i = 0; i + needle.length <= words.length; i += 1) {
    if (!needle.every((word, k) => words[i + k] === word)) continue;
    const before = words[i - 1] || '';
    const after = words[i + needle.length] || '';
    // 片名前面是 Sia / Apple / Marvel_s / of 这类别的英文词 → 只是字符串的一部分。
    // 中文不用挡：「星期三.Wednesday.S02E08」里英文名前面就是中文译名，是同一部片。
    if (before && !CJK_RE.test(before) && !/^(s\d{1,2}|ep|e\d{1,3}|\d{1,2}x\d{1,3}|(19|20)\d{2})$/.test(before)) continue;
    // 片名后面：季集标记 / 年份 / 画质 / 语言 / 中文注释 → 就是这部片
    if (after && !FRIENDLY_SUFFIX_RE.test(after) && !LANGUAGE_SUFFIX_RE.test(after) && !CJK_RE.test(after)) {
      if (!/^(the|a|an|and|of)$/.test(after)) continue;
    }
    return 1 + needle.length * 0.01;
  }
  return 0;
}

// 名字是不是「以这个英文片名打头」：是的话返回片名后面剩下的词，否则 null
function titlePrefixRest(name, title) {
  const words = name.split(' ').filter(Boolean);
  const needle = normalize(title).split(' ').filter(Boolean);
  if (needle.length === 0 || words.length < needle.length) return null;
  for (let index = 0; index < needle.length; index += 1) {
    if (words[index] !== needle[index]) return null;
  }
  return words.slice(needle.length);
}

// 这些词紧贴在片名前面时，说明片名只是被修饰的一个词（the REAL Greatest / 50 OF THE
// greatest MOVIE quotes / Marvel's Greatest Villain），不是那部片
const LEFT_NOISE_RE =
  /^(the|a|an|real|really|greatest|best|worst|first|last|most|50|100|top|all|every|one|of|my|your|his|her|their|its|our|great|biggest|favourite|favorite|ultimate|movie|film|quotes|moments|scenes|speeches|hits|songs|games|game|show)$/;

// 片名后面紧跟的这些东西说明「还是这部片」：S01 / 2024 / 第1集 / 1080p / chs / 中文注释
// 片名后面紧跟：季/集标记、年份、画质、纯数字（Interstellar.2014.720p…；字幕站那种
// 「….avi_1421217074 ansi-ad.srt」的数字串）
const FRIENDLY_SUFFIX_RE = /^(s\d|season|ep|e\d|\d{1,4}(p|bit)?\d*|20\d{2}$)/;
const LANGUAGE_SUFFIX_RE = /^(chs|cht|eng|gb|big5|zh|sc|tc|ra?r|sub|ass|srt|vtt|hdtv|web|bluray|bdrip|remux|dvdrip|x26[45]|h26[45]|aac|ac3|ddp|proper|repack|extended|imax|uhd|hdr|dv|10bit|8bit|双语|中英|简|繁)/;

function looksLikeOtherFilm(name, titles) {
  for (const title of titles) {
    if (CJK_RE.test(title)) continue;
    const rest = titlePrefixRest(name, title);
    if (!rest || rest.length === 0) continue;
    const next = rest[0];
    if (FRIENDLY_SUFFIX_RE.test(next)) continue;
    if (LANGUAGE_SUFFIX_RE.test(next)) continue;
    if (CJK_RE.test(next)) continue;
    // 后面这些词是发布名的常见尾巴，不构成「别的片」
    if (/^(the|a|an|and|of|in|on|at|for|to|with|from|show|movie|film|series|part)$/.test(next)) continue;
    // 「Dune」vs「Dune Part Two」：候选片名正好是从这里接着写的，是同一部片
    const joined = normalize(` ${rest.join(' ')} `);
    if (titles.some((other) => !CJK_RE.test(other) && other !== title && hasToken(joined, normalize(other).split(' ').pop()))) continue;
    return true;
  }
  return false;
}

/**
 * 身份判定：这条字幕是不是「这部片」。
 *
 * 迅雷是**模糊搜索**：搜「黑暗召唤师在地下恋爱中」返回 18 条（恋爱中的女人、召唤师技能推荐…）
 * 外加 1 条真的（`黑暗召唤师在地下恋爱中第3集.ass`）。以前要求「片名整串出现」才算，
 * 那 1 条真的也被丢掉 —— 这是「搜不到东西」的根本原因。
 *
 * 所以改用 SubHD 那种「按作品认片」的思路：算用户名和条目名的**最长公共片段**，
 * 够长就算同一部（中文 ≥3 字 / 英文 ≥2 个词）。硬性排除照旧保留：
 * 年份不符、季号不符、片名被别的实词接住（Sia - The Greatest）、被修饰（50 of the greatest…）、
 * 不是影视字幕（MV / 球赛 / 演讲）。
 */
export function checkIdentity(item, want) {
  const raw = String(item.haystack || '');
  const haystack = normalize(raw);
  const titles = [...new Set([...want.titles, ...(want.aliases || [])].filter(Boolean))];
  if (titles.length === 0) return { ok: false, score: 0, reason: '没有片名可比' };

  // 1) 片名：整串命中优先；不中就算最长公共片段
  let best = 0;
  for (const title of titles) {
    best = Math.max(best, matchTitle(title, haystack), sharedRun(title, haystack, want));
  }
  if (best === 0) return { ok: false, score: 0, reason: '片名对不上' };

  // 2) 「以片名打头、后面接别的实词」→ 另一部片（Sia - The Greatest / SCTV The Greatest Show）
  if (item.headOnly && item.head) {
    const head = normalize(String(item.head).toLowerCase());
    if (looksLikeOtherFilm(head, titles)) return { ok: false, score: 0, reason: '片名后面跟着别的词（是另一部片）' };
  }
  const fileName = normalize(String(item.fileName || '').toLowerCase());
  if (fileName && looksLikeOtherFilm(fileName, titles)) {
    return { ok: false, score: 0, reason: '文件名是别的片' };
  }

  // 3) 季号：写了就必须是这一季
  const season = seasonInfo(raw);
  if (want.season && season !== null && season !== Number(want.season)) {
    return { ok: false, score: 0, reason: `季号不符（要 S${want.season}）` };
  }
  if (want.season && season === Number(want.season)) best += 0.5;

  // 4) 年份：写了就必须对得上（±1 年，跨年上映很常见）
  const years = yearsIn(raw);
  if (want.year && years.size > 0) {
    const wanted = Number(want.year);
    if ([...years].every((year) => Math.abs(Number(year) - wanted) > 1)) {
      return { ok: false, score: 0, reason: `年份不符（要 ${want.year}）` };
    }
    best += 1;
  }

  // 5) 电影不要剧集字幕
  if (want.type === 'movie' && want.needType !== false) {
    const info = episodeInfo(raw);
    if (info.episode || info.pack || /全\s*\d+\s*集|第\s*[零一二三四五六七八九十百千\d]+\s*季/i.test(raw)) {
      return { ok: false, score: 0, reason: '是剧集的字幕' };
    }
  }

  // 6) 不是影视字幕（MV / 歌词 / 球赛 / 演讲…）
  if (looksNotFilm(raw)) return { ok: false, score: 0, reason: '不是影视字幕' };

  // 7) 整季合集、花絮：留着，排后面
  if (want.type === 'series' && isWholeShow(raw)) best -= 0.3;
  if (looksExtra(raw)) best -= 1.5;

  return { ok: true, score: best, reason: '' };
}

// 迅雷会把一部分条目的文件名截断成 10~12 个字符（「game.of.th」），或者换成 40 位十六进制哈希
// （2B7CDDE5…srt）。这两种名字里什么信息都没有，分不清是哪一季、哪一集，用户点开就对不上 ——
// 实测《权力的游戏》60 条里有 45 条是这样。这类条目要直接剔除，不能只靠 simple_name 的片名放行。
const HASH_NAME_RE = /^[0-9a-f]{16,}\.(srt|ass|ssa|vtt)$/i;
export const isHashName = (text) => HASH_NAME_RE.test(String(text || '').trim());

// 文件名是否「截断/无信息」：去掉扩展名后只有几个词，且没有季集/年份/画质这些线索
export function isTruncatedName(name) {
  const value = String(name || '').trim();
  if (!value) return true;
  const base = value.replace(/\.[a-z0-9]{2,4}$/i, '');
  if (HASH_NAME_RE.test(value)) return true;
  // 长度很短（10~12 个字符，如 game.of.th）且没有任何可辨识线索 → 没法用
  if (base.length <= 14) {
    const hasInfo = /\d|第\s*\d+\s*[季集]|S\d{1,2}|EP?\d/i.test(base);
    if (!hasInfo) return true;
  }
  return false;
}

// 中文：用户名和条目名的**最长公共片段**要同时满足两条才算同一部：
//   ① 至少 4 个字（「恋爱中」3 个字太泛，会命中《恋爱中的女人》）
//   ② 至少占片名的 50%（「黑暗召唤师在地下恋爱中第3集」命中 10/11 字 → 认；
//      「离婚律师恋爱中」只命中 3 个字 → 不认）
// 片名本身不足 4 个字的（「沙丘」「越狱」）走另一条：整串出现，且前后要有边界。
// 英文：公共词数 ≥2 个词，占片名一半以上。
const MIN_CJK_SHARED = 4;

export function sharedRun(title, haystack, want = null) {
  const needle = normalize(cleanTitle(title).replace(CJK_NOISE, ' '));
  if (!needle) return 0;

  if (CJK_RE.test(needle)) {
    const cjkTitle = (needle.match(/[\u3400-\u4dbf\u4e00-\u9fff]+/g) || []).join('');
    const cjkHay = (haystack.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || []).join('');
    // 短片名（「校园」「越狱」这种 2~3 个字）：只能整串命中，而且要在「词的开头」出现
    // —— 搜「校园」要能出「校园接送恋曲」，但不能出「小小的我」。
    if (cjkTitle.length < MIN_CJK_SHARED) {
      if (!cjkHay.includes(cjkTitle)) return 0;
      // 短片名最容易撞上「同名续集 / 同名前缀」，交给年份把关（沙丘 2021 vs 沙丘奇兵 1990）
      if (want && want.year) {
        const years = yearsIn(haystack);
        if (years.size > 0 && ![...years].some((y) => Math.abs(Number(y) - Number(want.year)) <= 1)) return 0;
      }
      // 条目名往往直接以它开头（校园接送恋曲第1集），或者用分隔符隔开
      if (cjkHay.startsWith(cjkTitle)) return 0.9;
      if (new RegExp(`[\\s\\u00b7:：\\-—_]${cjkTitle}`).test(cjkHay)) return 0.8;
      return 0;
    }
    const required = Math.max(MIN_CJK_SHARED, Math.ceil(cjkTitle.length * 0.5));
    for (let len = cjkTitle.length; len >= required; len -= 1) {
      for (let start = 0; start + len <= cjkTitle.length; start += 1) {
        if (cjkHay.includes(cjkTitle.slice(start, start + len))) {
          return 0.5 + (len / cjkTitle.length) * 0.5;
        }
      }
    }
    return 0;
  }

  const words = needle.split(' ').filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
  if (words.length < 2) return 0;
  const hits = words.filter((word) => hasToken(haystack, word)).length;
  if (hits < 2) return 0;
  return 0.5 + (hits / words.length) * 0.5;
}

/**
 * 集判定：越小越靠前，null = 明确是别的集，不该出现。
 */
export function episodeRank(item, want) {
  if (!want.episode) return 0;
  const raw = String(item.haystack || '');
  // 哈希文件名：看不出是哪一集，留着排最后（用户点开自己看）
  if (isHashName(item.haystack)) return 2;

  if (isWholeShow(raw)) return 3; // 全剧合集：留着，排最后
  const info = episodeInfo(raw);
  if (info.pack) return 3; // 整季包：留着，排最后
  if (info.episode === null) {
    // 没写集号：写了季号的算这一季的整季包，什么都没写的算整部剧
    return seasonInfo(raw) !== null ? 3 : 2;
  }
  if (info.episode !== Number(want.episode)) return null; // 明确是别的集
  const season = seasonInfo(raw);
  if (season === null || !want.season) return 0;
  return season === Number(want.season) ? 0 : 4; // 同集号、别的季
}

export { CJK_RE };
