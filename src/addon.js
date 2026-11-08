import { ADDON_ID, ADDON_VERSION, config, subtitleSources } from './config.js';
import { detectEpisodeInText, episodeFromName, parseVideoId, seasonFromName } from './parse.js';
import { chineseTitle, clipMiddle, dropSharedPrefix, episodeSuffix } from './label.js';
import { log } from './log.js';
import { TtlCache } from './cache.js';
import { isSourceBlocked, noteSourceFailure, noteSourceSuccess } from './health.js';
import { isThunderEnabled, thunderSubtitles } from './thunder.js';
import { isAssrtEnabled, assrtSubtitles } from './assrt.js';
import { sourceCatalog } from './catalog.js';
import {
  AppError,
  findEntries,
  getWork,
  latest,
  mapLimit,
  noteFor,
  search,
  worksFromEntries,
} from './subhd.js';

const CATALOG_SEARCH_MOVIE = 'subhd-movie-search';
const CATALOG_SEARCH_SERIES = 'subhd-series-search';
const CATALOG_LATEST_MOVIE = 'subhd-movie-latest';
const CATALOG_LATEST_SERIES = 'subhd-series-latest';

// 图形字幕：字幕在文件里是一帧帧图片（SUP/PGS），Stremio 的文本渲染器画不出来，
// 只有 mpv 这类能解图形字幕的播放器才放得出来。它们照样进列表（见 usableEntry），
// 但要在行里写明白，别让人以为是插件坏了。
const IMAGE_FORMATS = new Set(['SUP', 'PGS']);
// 这些连「一个文件」都不算：VobSub 要 .idx + .sub 一对，MKS 是 Matroska 容器。
// 打包不成一条字幕直链，仍然不进列表。
const UNPLAYABLE_FORMATS = new Set(['SUB', 'IDX', 'MKS']);

export function buildManifest(baseUrl) {
  // 字幕资源只能叫 "subtitles"。Stremio 客户端（stremio-core 的 Manifest::is_resource_supported）
  // 是拿请求里的资源名去 resources 里「精确匹配 name」的：写 "subtitles-thunder" 这种名字，
  // 客户端根本不认为这个插件提供字幕，字幕列表就是空的。所以三个来源合并在同一个
  // /subtitles 接口里返回（每行 label 带来源前缀，见 SOURCE_TAG）。
  const ids = subtitleSources();
  const multi = ids.length > 1;
  const sourceNames = ids.map((id) => SOURCE_NAMES[id] || id).join(' + ');

  return {
    id: ADDON_ID,
    version: ADDON_VERSION,
    name: multi ? `${sourceNames} 字幕` : `${SOURCE_NAMES[idleSource()]} 中文字幕`,
    description:
      `从 ${sourceNames} 搜索并下载中文字幕。安装后播放任意影片时自动匹配简繁/双语字幕；` +
      '也可以在本插件的「搜索」目录里按片名搜索，或直接打开插件首页用网页搜索下载。',
    logo: `${baseUrl}/assets/logo.svg`,
    types: ['movie', 'series'],
    resources: ['catalog', { name: 'subtitles', types: ['movie', 'series'], idPrefixes: ['tt'] }],
    catalogs: [
      ...ids.flatMap((source) => {
        const name = SOURCE_NAMES[source] || source;
        const prefix = multi ? `${source}-` : '';
        return [
          {
            type: 'movie',
            id: `${prefix}movie-search`,
            name: `${name} · 电影`,
            extra: [{ name: 'search', isRequired: true }],
          },
          {
            type: 'series',
            id: `${prefix}series-search`,
            name: `${name} · 剧集`,
            extra: [{ name: 'search', isRequired: true }],
          },
          // 最新字幕只有 SubHD 和射手（伪）有列表；迅雷只能按名字搜
          ...(source === 'thunder'
            ? []
            : [
                {
                  type: 'movie',
                  id: `${prefix}movie-latest`,
                  name: `${name} · 最新电影`,
                  extra: [{ name: 'skip' }],
                },
                {
                  type: 'series',
                  id: `${prefix}series-latest`,
                  name: `${name} · 最新剧集`,
                  extra: [{ name: 'skip' }],
                },
              ]),
        ];
      }),
    ],
  };
}

const SOURCE_NAMES = {
  subhd: 'SubHD',
  thunder: '迅雷',
  assrt: '射手(伪)',
};
const SOURCE_TAG = {
  subhd: 'SubHD',
  thunder: '迅雷',
  assrt: '射手(伪)',
};

// 关掉 SubHD 之后还剩下哪几个来源；一个都不剩时名字退回 SubHD（正常情况下不会发生）。
function idleSource() {
  return subtitleSources()[0] || 'subhd';
}

const workType = (work) => work.type || 'movie';

function toMetaPreview(work, type) {
  const subtitleCount = work.subtitles?.length || 0;
  const descriptionParts = [];
  if (work.altName && work.altName !== work.name) descriptionParts.push(work.altName);
  descriptionParts.push(`SubHD 收录 ${subtitleCount} 条中文字幕`);
  if (work.genres) descriptionParts.push(work.genres);

  const meta = {
    id: work.imdbId,
    type,
    name: work.name || work.altName || work.imdbId,
    posterShape: 'poster',
    description: descriptionParts.join(' · ').slice(0, 900),
  };
  if (work.poster) meta.poster = work.poster;
  if (work.year) meta.releaseInfo = String(work.year);
  return meta;
}

export async function catalogHandler({ type, id, extra = {} }) {
  const metas = [];

  // 迅雷 / 射手（伪）的目录：<来源>-<类型>-search|latest
  const sourceMatch = String(id).match(/^(thunder|assrt)-(movie|series)-(search|latest)$/);
  if (sourceMatch) {
    const [, source, , kind] = sourceMatch;
    if (!subtitleSources().includes(source)) return { metas: [] };
    return { metas: await sourceCatalog({ type, source, kind, keyword: String(extra.search || ''), skip: Number(extra.skip || 0) }) };
  }

  if (id === CATALOG_SEARCH_MOVIE || id === CATALOG_SEARCH_SERIES) {
    const keyword = String(extra.search || '').trim();
    if (!keyword) return { metas };

    const result = await search(keyword, { page: 1 });
    const works = await worksFromEntries(result.entries, {
      limit: config.catalogWorkLimit,
    });

    const seenIds = new Set();
    for (const work of works) {
      if (workType(work) !== type) continue;
      if (seenIds.has(work.imdbId)) continue;
      seenIds.add(work.imdbId);
      metas.push(toMetaPreview(work, type));
    }
    return { metas };
  }

  if (id === CATALOG_LATEST_MOVIE || id === CATALOG_LATEST_SERIES) {
    const skip = Number(extra.skip || 0);
    const page = Math.floor(skip / 20) + 1;
    const result = await latest(type, { page });
    const works = await worksFromEntries(result.entries, { limit: config.catalogWorkLimit });

    const seenIds = new Set();
    for (const work of works) {
      if (workType(work) !== type) continue;
      if (seenIds.has(work.imdbId)) continue;
      seenIds.add(work.imdbId);
      metas.push(toMetaPreview(work, type));
    }
    return { metas: metas.slice(0, 20) };
  }

  return { metas };
}

const formatsOf = (entry) => (entry.formats || []).map((format) => String(format).toUpperCase());

// 站点说这一条是 SUP/PGS，而不是「包里除了文本还带着图形字幕」—— 只有前者才值得
// 单列成一条图形字幕轨道。
export const isImageEntry = (entry) => {
  const formats = formatsOf(entry);
  return formats.length > 0 && formats.every((format) => IMAGE_FORMATS.has(format));
};

export function usableEntry(entry, { includeImage = config.includeImageSubtitles } = {}) {
  const formats = formatsOf(entry);
  if (formats.length === 0) return true;
  if (formats.some((format) => !IMAGE_FORMATS.has(format) && !UNPLAYABLE_FORMATS.has(format))) return true;
  return includeImage && formats.every((format) => !UNPLAYABLE_FORMATS.has(format));
}

export function preferredExt(entry) {
  if (isImageEntry(entry)) return 'sup';
  const formats = formatsOf(entry);
  const hasAss = formats.some((format) => format.includes('ASS') || format.includes('SSA'));
  const hasSrt = formats.some((format) => format.includes('SRT'));
  return hasAss && !hasSrt ? 'ass' : 'srt';
}

// 「中英双语」这种中英同在一份文件里的字幕，客户端认不出来是哪种中文，直接写「双语」
const CLIENT_BILINGUAL = '中英双语';

const QUALITY_LABELS = {
  '2160p': '2160p',
  '1440p': '1440p',
  '1080p': '1080p',
  '720p': '720p',
  '576p': '576p',
  '480p': '480p',
  '4k': '4K',
  '8k': '8K',
};

const SOURCE_LABELS = {
  remux: 'REMUX',
  bluray: 'BluRay',
  'blu-ray': 'BluRay',
  bdrip: 'BDRip',
  'bd-rip': 'BDRip',
  brrip: 'BRRip',
  'web-dl': 'WEB-DL',
  'web.dl': 'WEB-DL',
  webdl: 'WEB-DL',
  webrip: 'WEBRip',
  web: 'WEB',
  hdtvrip: 'HDTVRip',
  hdtv: 'HDTV',
  hdrip: 'HDRip',
  dvdrip: 'DVDRip',
};

// Stremio 只渲染字幕轨道的 label，第二行固定显示插件名（stremio-core 里写死
// origin = manifest.name），所以行标题必须同时带上字幕名称和语言。
export function languageText(entry) {
  const languages = (entry.languages || []).map((lang) => String(lang));
  const has = (pattern) => languages.some((lang) => pattern.test(lang));
  const bilingual = has(/双语|雙語|双字|三语|三語|中英/);
  const simplified = has(/简/);
  const traditional = has(/繁/);
  const english = has(/英/);
  const japanese = has(/日/);

  if (!simplified && !traditional && !english) return japanese ? '日语' : '中文字幕';
  if (bilingual && !simplified && !traditional) return CLIENT_BILINGUAL;
  if (english && !simplified && !traditional) return '英语';
  if (simplified && traditional && !english) return bilingual ? '简繁双语' : '简繁中';
  if (simplified && !traditional && !english) return bilingual ? '简中双语' : '简中';
  if (traditional && !simplified && !english) return bilingual ? '繁中双语' : '繁中';

  const scripts = `${simplified ? '简' : ''}${traditional ? '繁' : ''}英`;
  if (!bilingual) return scripts;
  return scripts === '简繁英' ? '简繁英三语' : `${scripts}双语`;
}

function releaseTag(entry) {
  const filename = String(entry.filename || '');
  const tags = [];
  const quality = filename.match(/(2160p|1440p|1080p|720p|576p|480p|4K|8K)/i);
  if (quality) tags.push(QUALITY_LABELS[quality[1].toLowerCase()]);
  const source = filename.match(
    /(REMUX|Blu-?Ray|BD-?Rip|BR-?Rip|WEB-?DL|WEB\.DL|WEB-?Rip|WEB|HDTVRip|HDTV|HDRip|DVDRip)/i,
  );
  if (source) tags.push(SOURCE_LABELS[source[1].toLowerCase()] || source[1]);
  return tags.join(' ');
}

// 作品名缺失时的兜底：用发布名（去掉字幕扩展名）。行标题有整行的宽度，不用截到 18 字。
function releaseName(entry) {
  return String(entry.filename || entry.title || '')
    .replace(/\.(srt|ass|ssa|sup|sub|idx|zip|rar|7z|txt)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// 发布名里写着、别处看不到的关键词（AI 校对、特效字幕……），留到行标题上。
const TITLE_KEYWORDS = [
  [/双语特效|特效双语/, '双语特效'],
  [/特效/, '特效'],
  [/\bAI\b|AI\s*校对|AI\s*翻译|AI字幕/i, 'AI'],
  [/台词|注释/, '注释'],
];

function titleKeywords(entry) {
  const haystack = `${entry.filename || ''} ${entry.title || ''}`;
  const found = [];
  for (const [pattern, label] of TITLE_KEYWORDS) {
    if (found.includes(label)) continue;
    // 认出了「双语特效」就不用再单独挂一个「特效」
    if (label === '特效' && found.includes('双语特效')) continue;
    if (pattern.test(haystack)) found.push(label);
  }
  return found;
}

const LABEL_NAME_MAX = 48;
const LABEL_SUBTITLE_MAX = 72;
const LABEL_MAX = 132;

// 行标题（label）：中文名 + 正在看的集号 + 站点上这条字幕自己的名字。
// 以前第一行只有作品名（「怪奇物语 第一季 Stranger Things」），同一集下的十几条字幕
// 在只看 label 的客户端里长得一模一样 —— 第二行的语言/字幕组不是每个客户端都渲染，
// 于是哪条是谁翻的根本分不出来。所以字幕名要上第一行：太长就留开头和结尾、中间用
// 省略号，结尾那一截往往才是「字幕组 / 简体&英文 / 特效」。特效、AI 这些标记不占第一行，
// 统一放到第二行（见 subtitleMeta）。
export function subtitleLabel(entry) {
  const fullName = String(
    entry.workName || entry.title || entry.posterAlt || releaseName(entry) || entry.badge || SOURCE_NAMES[entry.source] || 'SubHD',
  )
    .replace(/\s+/g, ' ')
    .trim();
  const chinese = chineseTitle(fullName);
  const fallback = SOURCE_NAMES[entry.source] || 'SubHD';
  const name = clipMiddle(chinese || fullName, LABEL_NAME_MAX) || fallback;

  // 站上这条字幕自己的名字（发布名）。和作品名一模一样时（搜索页里作品名就是发布名的
  // 那种条目）不用再说一遍。
  const rawSubtitleName = dropSharedPrefix(releaseName(entry), chinese || fullName);
  const subtitleName =
    rawSubtitleName && rawSubtitleName !== fullName && rawSubtitleName !== chinese
      ? clipMiddle(rawSubtitleName, LABEL_SUBTITLE_MAX)
      : '';

  const parts = [
    name,
    episodeSuffix(name, { season: entry.seasonNumber ?? entry.season, episode: entry.episodeNumber ?? entry.episode }),
    subtitleName,
  ].filter(Boolean);
  return clipMiddle(parts.join(' · '), LABEL_MAX);
}

// 行下方那一行是客户端用 lang 渲染的（安卓版显示的就是它，stremio-web 拿它当
// 没有 label 时的兜底），所以语言、字幕组、格式、来源都塞在这里。发布名里那些「特殊
// 情况」——特效、AI 校对、带注释——也放这儿：第一行只留名字，这些标记挤上去反而看不清。
export function subtitleMeta(entry) {
  const parts = [languageText(entry), ...titleKeywords(entry)];
  if (entry.seasonPack) parts.push('整季');
  if (entry.group) parts.push(entry.group);
  if (entry.formats?.length) parts.push(entry.formats.join('/').toUpperCase());
  // 图形字幕要客户端自己会画图片，写清楚免得用户以为是插件坏了
  if (isImageEntry(entry)) parts.push('图形字幕');
  if (entry.badge && entry.badge !== '其他来源') parts.push(entry.badge);
  // 非 SubHD 来源在第二行写明出处（第一行可能只显示片名）
  if (entry.sourceName) parts.push(entry.sourceName);
  const quality = releaseTag(entry);
  if (quality) parts.push(quality);
  return parts.filter(Boolean).join(' · ');
}

// 有些客户端（Stremio 安卓版等）把字幕轨道 id 直接当标题显示，所以 id 里也要
// 带上人话，不然列表里只有 subhd-<站点编号> 这种纯代码。语言也要带上：同一条字幕
// 会按语言拆成好几条轨道（简中 / 繁中 / 日语……），id 不能让它们撞车。
export function subtitleId(entry) {
  return `${clipMiddle(subtitleLabel(entry), 60)} · ${languageText(entry)} · ${entry.sid}`;
}

// 站点的语言标签写的是「这个压缩包里有哪些语言」。以前一条字幕只挑一份文件
// （先中文后其它），于是「简体 + 繁体」的包永远只给简中，「繁体 + 日语」的包点繁中
// 会拿到日语。现在按标签把每种语言各列一条轨道，各自带着语言代码去包里挑文件。
const LANGUAGE_CODES = [
  [/日/, 'ja'],
  [/[韩韓]/, 'ko'],
  [/英/, 'en'],
  [/法/, 'fr'],
  [/德/, 'de'],
  [/西班牙/, 'es'],
  [/意大利|義大利/, 'it'],
  [/俄/, 'ru'],
  [/葡萄牙/, 'pt'],
  [/阿拉伯/, 'ar'],
  [/波兰|波蘭/, 'pl'],
  [/荷兰|荷蘭/, 'nl'],
  [/瑞典/, 'sv'],
  [/土耳其/, 'tr'],
  [/丹麦|丹麥/, 'da'],
  [/挪威/, 'no'],
  [/芬兰|芬蘭/, 'fi'],
  [/泰/, 'th'],
  [/越南/, 'vi'],
  [/希腊|希臘/, 'el'],
  [/捷克/, 'cs'],
  [/匈牙利/, 'hu'],
];

const languageCodeOf = (tag) =>
  LANGUAGE_CODES.find(([pattern]) => pattern.test(String(tag)))?.[1] || null;

// 「双语 / 三语」是「一份文件里中英都有」的意思，所以外文不用再单独列一条（列了也是
// 同一份文件）；简繁各一份的包才是两条真正不同的轨道。
export function languageVariants(entry) {
  const tags = (entry.languages || []).map((tag) => String(tag));
  const bilingual = tags.some((tag) => /双语|雙語|双字|三语|三語/.test(tag));
  const simplified = tags.some((tag) => /简|簡/.test(tag));
  const traditional = tags.some((tag) => /繁/.test(tag));
  const others = tags.filter(
    (tag) => /语|語/.test(tag) && !/简|簡|繁|中|双|雙|国|國|其它/.test(tag),
  );

  const variants = [];
  const script = (lang, tag) => {
    variants.push({ lang, languages: bilingual ? ['双语', tag, '英语'] : [tag] });
  };
  if (simplified) script('zh-Hans', '简体');
  if (traditional) script('zh-Hant', '繁体');
  if (!bilingual) {
    for (const tag of others) {
      const lang = languageCodeOf(tag);
      if (lang) variants.push({ lang, languages: [tag] });
    }
  }

  if (variants.length === 0) return [{ lang: null, entry }];
  // 一个包最多列 4 条，别把一次列表撑爆
  return variants.slice(0, 4).map((variant) => ({
    lang: variant.lang,
    entry: { ...entry, languages: variant.languages },
  }));
}

// 作品页上「怪奇物语 第五季」和「《怪奇物语》第五季幕后」都会被解析成第 5 季，
// 优先挑正好以「第N季」结尾的那个，别把幕后花絮当成正片。
export function pickSeasonWork(work, season) {
  const candidates = (work.relatedWorks || []).filter((item) => item.season === season);
  return candidates.find((item) => /季\s*$/.test(item.name)) || candidates[0] || null;
}

// 搜索页里的作品页要分成三堆：正好是用户在看的那一季、完全读不出季号的、明确是别的季的。
// 读不出季号的（长番、`S06` 这种只有发布名的标题、圣诞特别集）不能混进第一堆，否则
// 《万物生灵》第二季会被这些条目当成「已经找到了」，永远走不到顺其它季链接去找的兜底。
export function splitWorksBySeason(entries, season) {
  const matched = [];
  const unknown = [];
  const others = [];
  for (const entry of entries) {
    const workId = entry?.workId;
    if (!workId || matched.includes(workId) || unknown.includes(workId) || others.includes(workId)) continue;
    const entrySeason = seasonFromName(entry.title) ?? seasonFromName(entry.posterAlt);
    if (!season || entrySeason === season) matched.push(workId);
    else if (entrySeason === null) unknown.push(workId);
    else others.push(workId);
  }
  return { matched, unknown, others };
}

async function collectSeriesEntries(imdbId, season, episode) {
  const { entries } = await findEntries(imdbId, { pages: 2 });

  const { matched, unknown, others } = splitWorksBySeason(entries, season);
  const workIds = matched.slice(0, 6);

  // 搜索页按热度混排，想看的这一季经常整季都不在前两页里（《万物生灵》第二季就是：
  // 前两页全是第五~七季和圣诞特别集）。同一部剧任意一季的作品页上都有其它季的链接，
  // 顺着它把这一季找出来。
  if (season && workIds.length === 0) {
    const siblingIds = await mapLimit([...others, ...unknown].slice(0, 8), 4, async (workId) => {
      try {
        const work = await getWork(workId);
        return pickSeasonWork(work, season)?.workId || null;
      } catch {
        return null;
      }
    });
    for (const workId of siblingIds) {
      if (workId && !workIds.includes(workId)) workIds.push(workId);
    }
  }

  // 还是找不到（《海贼王》这种整部剧就一个作品页、名字里没有「第N季」）：退回那几页
  // 读不出季号的作品，至少是这部剧的字幕，集号靠文件名判断。
  if (workIds.length === 0 && unknown.length > 0) workIds.push(...unknown.slice(0, 6));

  const works = await mapLimit(workIds, 4, async (workId) => {
    try {
      return await getWork(workId);
    } catch {
      return null;
    }
  });

  const exact = [];
  const packs = [];
  // 条目自己的 episode 是站点归类出来的（整季包常被挂在「第1集」下），
  // 行标题要显示的是「用户正在看的那一集」。
  const withRequest = (entry) =>
    episode ? { ...entry, episodeNumber: episode, seasonNumber: season ?? null } : entry;

  for (const work of works.filter(Boolean)) {
    for (const entry of work.subtitles) {
      const item = withRequest({ ...entry, workName: work.name });
      if (!episode) {
        exact.push(item);
        continue;
      }
      const namedEpisode = episodeFromName(item.filename || item.title);
      if (entry.episode === episode || namedEpisode === episode) exact.push(item);
      // 站点会把整季包挂在「第1集」下面，这种条目哪一集都能用（解压时按集挑文件）
      else if (namedEpisode === null) packs.push({ ...item, seasonPack: true });
    }
  }

  for (const entry of entries) {
    if (!episode) {
      exact.push(entry);
      continue;
    }
    const haystack = `${entry.filename || ''} ${entry.title || ''}`;
    if (entry.episode === episode || detectEpisodeInText(haystack, season, episode)) {
      exact.push(withRequest(entry));
    }
  }

  return [...exact, ...packs];
}

// 站点上的「默认排序」就是作品页（/d/<id>）上那一份，搜索结果只是按下载量排的。
// 照作品页的顺序排在前面，搜索页里多出来的条目补在后面。作品页的条目还带着作品名，
// 行标题才能显示片名而不是发布名。
export function orderEntriesByWorkPages(works, entries) {
  const ordered = [];
  const seen = new Set();
  for (const work of works.filter(Boolean)) {
    for (const entry of work.subtitles || []) {
      if (!entry?.sid || seen.has(entry.sid)) continue;
      seen.add(entry.sid);
      ordered.push({ ...entry, workName: work.name });
    }
  }
  for (const entry of entries) {
    if (!entry?.sid || seen.has(entry.sid)) continue;
    seen.add(entry.sid);
    ordered.push(entry);
  }
  return ordered;
}

async function collectMovieEntries(imdbId) {
  const { entries } = await findEntries(imdbId, { pages: 1 });

  const workIds = [];
  for (const entry of entries) {
    if (!entry.workId || workIds.includes(entry.workId)) continue;
    workIds.push(entry.workId);
    if (workIds.length >= 3) break;
  }

  const works = await mapLimit(workIds, 4, async (workId) => {
    try {
      const work = await getWork(workId);
      // 作品页有时候是「六部曲合集」这类页面，imdb 对不上就别把别的片子混进来。
      return work.imdbId && work.imdbId !== imdbId ? null : work;
    } catch {
      return null;
    }
  });

  return orderEntriesByWorkPages(works, entries);
}

// 用户点了一条之后最可能接着点的就是列表里它下面那一两条（看着不顺眼就往下换），
// 这两条会在后台被预热好，换的时候就不用再等 SubHD 现下现解压。
export function neighborSids(entries, index, limit = 2) {
  const sids = [];
  for (let offset = 1; offset <= Math.max(0, limit); offset += 1) {
    const sid = entries[index + offset]?.sid;
    if (sid) sids.push(sid);
  }
  return sids;
}

export function subtitleTrack(entry, { lang, season, episode, baseUrl, warm = [] }) {
  const params = new URLSearchParams();
  // 关键：链接里带的是「用户正在看的」季/集，而不是条目自己的编号。站点把整季包
  // 挂在「第1集」下面，用条目的 episode 会让解压永远挑出 E01 那个文件。
  const wantedSeason = season ?? entry.season;
  const wantedEpisode = episode ?? entry.episode;
  if (wantedSeason) params.set('s', String(wantedSeason));
  if (wantedEpisode) params.set('e', String(wantedEpisode));
  // 同一条字幕会按语言拆成好几条轨道，带上语言才知道该挑包里的哪份文件
  if (lang) params.set('lang', lang);
  // 顺手的后台预热：见 neighborSids / warmSubtitles
  if (warm.length > 0) params.set('warm', warm.join(','));
  const query = params.toString();
  // 已知是「假包」（包里只有一份网盘分享说明，字幕本体在网盘上）的条目：按文本轨道列出来，
  // 点开就能在画面里看见链接；第二行也直接写明白，不用等点一次才知道（见 noteSubtitle）。
  const note = noteFor(entry.sid);
  // 迅雷 / 射手（伪）的字幕直链是「一个文件」，不用经过 SubHD 那套压缩包解压：直接把
  // 原始地址写进 url（Stremio 自己从客户端那边去取，播放器能取到就取到）。取不到时客户端
  // 会退回到这里列出的这条轨道重试不了，所以在 label 里写清楚来源。
  const source = entry.source && entry.source !== 'subhd' ? entry.source : null;

  return {
    id: subtitleId(entry),
    // 迅雷 / 射手（伪）的 track 自己已经算好了 url（各自的代理路由），这里直接用
    url: entry.url || `${baseUrl}/sub/${entry.sid}.${note ? 'srt' : preferredExt(entry)}${query ? `?${query}` : ''}`,
    lang: note ? `只有网盘分享链接：${note}` : subtitleMeta(entry),
    label: subtitleLabel(entry),
  };
}

// SubHD 那一路：作品页 + 压缩包，顺序照抄站点。
async function subhdSubtitles({ type, id }, baseUrl) {
  const { imdbId, season, episode } = parseVideoId(id);
  if (!imdbId) return [];

  let entries;
  try {
    entries = type === 'series' ? await collectSeriesEntries(imdbId, season, episode) : await collectMovieEntries(imdbId);
  } catch (error) {
    if (error instanceof AppError) throw error;
    return [];
  }

  const seen = new Set();
  const unique = [];
  for (const entry of entries) {
    if (!entry?.sid || seen.has(entry.sid)) continue;
    seen.add(entry.sid);
    if (!usableEntry(entry)) continue;
    unique.push(entry);
  }

  // 站点自己的默认排序就是这个顺序（搜索页按热度、作品页按站点默认排序），
  // 不再按「简繁优先 / 徽章 / 下载量」重排，用户要的是站点那一份。
  const subtitles = [];
  for (const [index, entry] of unique.entries()) {
    const warm = neighborSids(unique, index, config.prefetchNeighbors);
    for (const variant of languageVariants(entry)) {
      if (subtitles.length >= config.maxSubtitleResults) break;
      subtitles.push(
        subtitleTrack(variant.entry, { lang: variant.lang, season, episode, baseUrl, warm }),
      );
    }
    if (subtitles.length >= config.maxSubtitleResults) break;
  }
  return subtitles;
}

// 三行合并成一个列表时，label 前面挂来源：只看第一行的客户端也分得清这条是哪个站的。
export function tagTrack(track, source) {
  const tag = SOURCE_TAG[source];
  if (!tag) return track;
  return {
    ...track,
    label: `${tag} · ${track.label}`,
    id: `${tag} · ${track.id}`,
  };
}

// 「同一部片的字幕列表」快照：客户端重试、用户来回切集时，秒回上次的结果，
// 不用再等三个站轮一遍（尤其是某个站连不上的时候）。
const snapshotCache = new TtlCache({ ttlMs: 30 * 60 * 1000, maxEntries: 400 });

// 三个来源各自的取数函数。单独抽出来只是为了让「合并 / 超时 / 熔断」这层能被测试
// 替换掉网络调用（生产路径就是用下面这几个默认实现）。
export const sourceLoaders = {
  subhd: (args) => subhdSubtitles(args, args.baseUrl),
  thunder: (args) => thunderSubtitles(args),
  assrt: (args) => assrtSubtitles(args),
};
const snapshotKey = (source, id) => `${source}:${id}`;
const readSnapshot = (source, id) => snapshotCache.get(snapshotKey(source, id)) || null;

/**
 * /subtitles/<type>/<id>.json —— 三个来源合在一个列表里。
 * `source` 参数只在调试时用（只取某一个站），客户端永远走默认的「全部」。
 */
export async function subtitlesHandler({ type, id }, baseUrl, source = null) {
  if (!/^tt\d+/.test(String(id || ''))) return { subtitles: [] };

  const enabled = subtitleSources();
  const want = (candidate) => !source || source === candidate;
  const deadlineMs = config.sourceDeadlineMs;

  // 每个来源一个任务：先看快照，没有再去站点拿；哪个站超时都不拖累别的。
  // 连不上的来源会被冷落一段时间（见 health.js），不再每次都白等满超时。
  const job = (name, task, limit) => {
    if (isSourceBlocked(name)) {
      log('debug', `[${name}] 刚失败过，暂时跳过`);
      return Promise.resolve([]);
    }

    const key = snapshotKey(name, id);
    const cached = readSnapshot(name, id);
    if (cached) return Promise.resolve(cached);

    const work = (async () => {
      try {
        const tracks = (await task()).slice(0, limit).map((track) => tagTrack(track, name));
        if (tracks.length > 0) {
          snapshotCache.set(key, tracks);
          noteSourceSuccess(name);
        }
        return tracks;
      } catch (error) {
        noteSourceFailure(name, error);
        log('warn', `[${name}] 字幕列表失败：${error.message}`);
        return [];
      }
    })();

    if (deadlineMs <= 0) return work;

    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), deadlineMs);
    });
    return Promise.race([work, timeout]).then((value) => {
      clearTimeout(timer);
      if (value === null) {
        log('warn', `[${name}] 超过 ${deadlineMs}ms 还没返回，先不等它（结果稍后进缓存）`);
        return [];
      }
      return value;
    });
  };

  // 三个来源一起出发。谁先回来不一定（SubHD 通常 1~2 秒，迅雷跨境可能 4 秒+），
  // 所以不等所有人：第一个来源回来就先用它的结果返回，剩下的在「还有多少余量」里继续等，
  // 等到了就补进这次响应（客户端一次只要等这么久，不会在某一个站上干耗）。
  const jobs = [];
  if (enabled.includes('subhd') && want('subhd')) {
    jobs.push(job('subhd', () => sourceLoaders.subhd({ type, id, baseUrl }), config.maxSubtitleResults));
  }
  if (enabled.includes('thunder') && want('thunder') && isThunderEnabled()) {
    jobs.push(job('thunder', () => sourceLoaders.thunder({ type, id, baseUrl }), config.thunder.maxResults));
  }
  if (enabled.includes('assrt') && want('assrt') && isAssrtEnabled()) {
    jobs.push(job('assrt', () => sourceLoaders.assrt({ type, id, baseUrl }), config.assrt.maxResults));
  }
  if (jobs.length === 0) return { subtitles: [] };

  const merged = await collectFirstThenRest(jobs);
  // 按来源顺序拼（SubHD 在前，跟以前一样），再整体截到上限
  const subtitles = merged.flat().slice(0, config.maxMergedResults);
  return { subtitles };
}

/**
 * 先等第一个有结果的来源，再用剩下的时间（最多 totalMs）把其它的补进来。
 * 任何一个来源迟迟不回，也不会把整个响应拖住。
 */
export async function collectFirstThenRest(jobs, totalMs = config.sourceDeadlineMs) {
  const results = new Array(jobs.length).fill(null);
  const started = Date.now();
  const empty = (value) => !Array.isArray(value) || value.length === 0;

  // 每个任务的返回都包成 { index, value }；超时用独立的 TIMEOUT 哨兵，
  // 不用 null（null 和「空数组结果」容易混）。
  const TIMEOUT = Symbol('timeout');
  const waitFor = (list, ms) =>
    Promise.race([
      ...list.map((item) => item.promise.then((value) => ({ item, ...value }))),
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(TIMEOUT), Math.max(0, ms));
        // 防止定时器在竞速结束后继续挂着，拖住进程
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);

  // 每项记住自己的 promise，回来之后按 promise 移除，避免 index 错位
  let pending = jobs.map((promise, index) => {
    const wrapped = promise.then((value) => ({ index, value }));
    return { index, promise: wrapped, done: false };
  });
  const consume = (list, next) => list.filter((item) => item !== next.item);

  // 第一轮：等到第一个「真的有字幕」的来源。空结果不算数 —— 等它等于白等；
  // 但如果所有来源都是空的，也别一直等到超时。
  let empties = 0;
  while (pending.length > 0 && empties < jobs.length) {
    const left = totalMs - (Date.now() - started);
    if (left <= 0) break;
    const next = await waitFor(pending, left);
    if (next === TIMEOUT) break;
    pending = consume(pending, next);
    results[next.index] = next.value;
    if (empty(next.value)) {
      empties += 1;
      continue;
    }
    break;
  }

  // 第二轮：剩下的来源只给一小段「补进来」的机会（默认 2 秒）。第一轮已经有结果了，
  // 用户没必要为另一个站再等下去；它晚到的结果会进缓存，下次点开就秒回。
  const remainingMs = Math.min(config.sourceLateGraceMs, Math.max(0, totalMs - (Date.now() - started)));
  let left = remainingMs;
  while (pending.length > 0 && left > 0) {
    const roundStart = Date.now();
    const next = await waitFor(pending, left);
    left -= Date.now() - roundStart;
    if (next === TIMEOUT) break;
    results[next.index] = next.value;
    pending = consume(pending, next);
  }
  return collectOrdered(results);
}

const collectOrdered = (results) => results.map((value) => (Array.isArray(value) ? value : []));

export { AppError, clipMiddle, chineseTitle };
