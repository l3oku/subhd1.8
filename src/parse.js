const collapse = (html) => String(html ?? '').replace(/\s+/g, ' ');

export function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export const cleanText = (html) =>
  decodeEntities(String(html ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

const SEARCH_ITEM_MARKER = '<div class="bg-white shadow-sm rounded-3 mb-4">';
const ANCHOR_RE = /<a\s+([^>]*?)href=['"]\/a\/([A-Za-z0-9]+)['"]([^>]*?)>([\s\S]*?)<\/a>/g;

function parseAnchors(block) {
  const anchors = [];
  ANCHOR_RE.lastIndex = 0;
  let match;
  while ((match = ANCHOR_RE.exec(block)) !== null) {
    anchors.push({
      attrs: `${match[1]} ${match[3]}`,
      sid: match[2],
      text: cleanText(match[4]),
    });
  }
  return anchors;
}

const toNumber = (value) => {
  const digits = String(value ?? '').replace(/[^\d]/g, '');
  return digits ? Number(digits) : 0;
};

export function parseEntry(block, context = {}) {
  const sid = (block.match(/href=['"]\/a\/([A-Za-z0-9]+)['"]/) || [])[1];
  if (!sid) return null;

  const anchors = parseAnchors(block);
  const primary = anchors.find((anchor) => anchor.sid === sid) || anchors[0];
  const nameAnchor = anchors.find((anchor) => /align-middle/.test(anchor.attrs));
  const fileAnchor = anchors.find((anchor) => /class=['"]link-dark['"]/.test(anchor.attrs));

  const imageTag = (block.match(/<img class="rounded-start"[^>]*>/) || [])[0] || '';

  const formats = [...block.matchAll(/<span class="p-1 text-secondary">([^<]+)<\/span>/g)]
    .map((match) => decodeEntities(match[1]).trim())
    .filter(Boolean);
  const languages = [...block.matchAll(/<span class="p-1 fw-bold">([^<]+)<\/span>/g)]
    .map((match) => decodeEntities(match[1]).trim())
    .filter(Boolean);
  const metrics = [...block.matchAll(/<span class=['"]align-text-top me-3['"]>([^<]*)<\/span>/g)]
    .map((match) => cleanText(match[1]));

  const badge = (block.match(/<span class="rounded p-1 me-1 text-white"[^>]*>([^<]+)<\/span>/) || [])[1];
  const group = block.match(/<a href=['"]\/zu\/(\d+)['"][^>]*>([^<]*)<\/a>/) || [];
  const uploader = block.match(/\/u\/([^'"]+)['"][^>]*>([^<]*)<\/a>/) || [];
  const timeMatch = block.match(/<time datetime="([^"]+)"/) || [];

  const rowDownloads = (block.match(/<div class="px-3 py-2 text-end text-secondary">([^<]*)<\/div>/) || [])[1];
  const downloads = metrics.length > 1 ? toNumber(metrics[1]) : toNumber(rowDownloads);
  const commentsMatch = block.match(/<span class="p-1 text-primary">[\s\S]*?<\/svg>\s*([\d,]+)\s*<\/span>/);
  const ratingMatch = block.match(/<span class="p-1 text-danger">[\s\S]*?<span class="align-baseline">\s*([\d,]+)\s*<\/span>/);

  const filename = fileAnchor?.text || primary?.text || '';
  const title = nameAnchor?.text || filename;

  return {
    sid,
    workId: (block.match(/href=['"]\/d\/(\d+)['"]/) || [])[1] || null,
    title,
    filename,
    languages,
    formats,
    badge: badge ? decodeEntities(badge).trim() : null,
    groupId: group[1] ? Number(group[1]) : null,
    group: group[2] ? decodeEntities(group[2]).trim() : null,
    sizeText: metrics[0] || null,
    downloads,
    comments: commentsMatch ? toNumber(commentsMatch[1]) : 0,
    rating: ratingMatch ? toNumber(ratingMatch[1]) : 0,
    publishedAt: timeMatch[1] || null,
    uploader: uploader[2] ? decodeEntities(uploader[2]).trim() : null,
    poster: (imageTag.match(/src="([^"]+)"/) || [])[1] || null,
    posterAlt: decodeEntities((imageTag.match(/alt="([^"]*)"/) || [])[1] || ''),
    season: context.season ?? null,
    episode: context.episode ?? null,
    source: context.source || 'search',
  };
}

export function parseSearchPage(html) {
  const raw = String(html ?? '');
  const text = collapse(raw);

  const totalText = (text.match(/(?:共|找到)\s*([\d,]+)\s*条/) || [])[1];
  const page = Number((text.match(/当前第\s*(\d+)\s*页/) || [])[1] || 1);

  const blocks = text.split(SEARCH_ITEM_MARKER).slice(1);
  const entries = [];

  for (const block of blocks) {
    const trimmed = block
      .split('<div class="col-lg-3')[0]
      .split('<ul class="pagination')[0]
      .slice(0, 8000);
    const entry = parseEntry(trimmed, { source: 'search' });
    if (entry) entries.push(entry);
  }

  return {
    total: totalText ? Number(totalText.replace(/,/g, '')) : entries.length,
    page,
    entries,
  };
}

function parseEpisodeHeader(label) {
  const episodeMatch = label.match(/第\s*(\d+)\s*集/);
  if (episodeMatch) return { season: null, episode: Number(episodeMatch[1]) };

  const seasonMatch = label.match(/第\s*([零一二三四五六七八九十百千\d]+)\s*季/);
  if (seasonMatch) return { season: parseChineseNumber(seasonMatch[1]), episode: null };

  return null;
}

export function parseChineseNumber(value) {
  const digits = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const text = String(value ?? '').trim();
  if (/^\d+$/.test(text)) return Number(text);

  let total = 0;
  let current = 0;
  for (const char of text) {
    if (char === '十') {
      total += (current || 1) * 10;
      current = 0;
    } else if (char === '百') {
      total += (current || 1) * 100;
      current = 0;
    } else if (digits[char] !== undefined) {
      current = digits[char];
    }
  }
  return total + current;
}

// 「第N季」，作品名、文件名和作品页上的其它季链接都用这个格式。
export function seasonFromName(name) {
  const match = String(name ?? '').match(/第\s*([零一二三四五六七八九十百千\d]+)\s*季/);
  return match ? parseChineseNumber(match[1]) : null;
}

// 名字里明确写着第几集（S01E03 / 1x03 / 第3集 / EP03）。
// 合集和范围（S05E01-08、全8集）返回 null：这种包要靠解压时按集挑文件。
const EPISODE_RANGE_RE =
  /S\d{1,2}\s*[EЕ]\s*\d{1,3}\s*[-–~至]\s*[EЕ]?\d{1,3}|第\s*\d{1,3}\s*[-–~至]\s*\d{1,3}\s*集|全\s*\d+\s*集/i;
const EPISODE_PATTERNS = [
  /S\d{1,2}\s*[EЕ]\s*(\d{1,3})(?![\d-])/i,
  /(?<![A-Za-z0-9])\d{1,2}\s*[xX]\s*(\d{1,3})(?![\d-])/,
  /第\s*(\d{1,3})\s*集/,
  /(?<![A-Za-z])(?:EP|E)\.?\s*(\d{1,3})(?![\d-])/i,
];

export function episodeFromName(text) {
  const source = String(text ?? '');
  if (EPISODE_RANGE_RE.test(source)) return null;
  for (const pattern of EPISODE_PATTERNS) {
    const match = source.match(pattern);
    if (match) return Number(match[1]) || null;
  }
  return null;
}

// 作品页会列出同一部剧的其它季（绝命毒师 第一季 → 第五季 /d/6952149）。
// 搜索页经常只返回其中几季，所以这些链接是找到「用户正在看的那一季」的关键。
const RELATED_WORK_RE = /<div class="fw-bold"><a href="\/d\/(\d+)" class="link-dark">([^<]*)<\/a><\/div>/g;

function parseRelatedWorks(text) {
  const seen = new Set();
  const works = [];
  RELATED_WORK_RE.lastIndex = 0;
  let match;
  while ((match = RELATED_WORK_RE.exec(text)) !== null) {
    const workId = match[1];
    if (seen.has(workId)) continue;
    seen.add(workId);
    const name = cleanText(match[2]);
    works.push({ workId, name, season: seasonFromName(name) });
  }
  return works;
}

export function parseWorkPage(html) {
  const text = collapse(html);
  const h1 = cleanText((text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '');
  const heading = h1.replace(/\s*\(\d{4}\)\s*$/, '').trim();
  const year = Number((h1.match(/\((\d{4})\)/) || [])[1]) || null;

  const posterTag = (text.match(/<img class="w-100"[^>]*>/) || [])[0] || '';
  const typeMatch = text.match(
    /<span class="bg-(?:primary|danger|success|warning|info|secondary) py-1 px-2 rounded-pill text-white">([^<]+)<\/span>/,
  );
  const summary = text.match(/<b>剧情<\/b>：([^<]*)/);
  const genres = text.match(/<b>类型<\/b>：([^<]*)/);

  const region = text.slice(Math.max(0, text.indexOf('字幕信息')));
  const markers = [];

  const headerRe = /<div class="px-3 py-1 f12 bg-light bg-gradient text-danger fw-bold">([^<]+)<\/div>/g;
  let match;
  while ((match = headerRe.exec(region)) !== null) {
    markers.push({ index: match.index, type: 'header', label: cleanText(match[1]) });
  }
  const rowRe = /<div class="row pt-2 mb-2">/g;
  while ((match = rowRe.exec(region)) !== null) {
    markers.push({ index: match.index, type: 'row' });
  }
  markers.sort((a, b) => a.index - b.index);

  const subtitles = [];
  let season = null;
  let episode = null;

  for (let i = 0; i < markers.length; i += 1) {
    const marker = markers[i];
    if (marker.type === 'header') {
      const parsed = parseEpisodeHeader(marker.label);
      if (parsed) {
        if (parsed.season !== null) season = parsed.season;
        episode = parsed.episode;
      }
      continue;
    }

    const end = i + 1 < markers.length ? markers[i + 1].index : region.length;
    const entry = parseEntry(region.slice(marker.index, end), { season, episode, source: 'work' });
    if (entry) subtitles.push(entry);
  }

  const typeLabel = typeMatch ? decodeEntities(typeMatch[1]).trim() : null;
  const type = typeLabel === '电影' ? 'movie' : typeLabel ? 'series' : null;

  return {
    workId:
      (text.match(/<a class="(?:link-dark me-1|me-1 link-dark)" href="\/d\/(\d+)"/) || [])[1] || null,
    name: heading,
    altName: decodeEntities((posterTag.match(/alt="([^"]*)"/) || [])[1] || ''),
    year,
    imdbId: (text.match(/imdb\.com\/title\/(tt\d+)/) || [])[1] || null,
    doubanId: (text.match(/movie\.douban\.com\/subject\/(\d+)/) || [])[1] || null,
    poster: (posterTag.match(/src="([^"]+)"/) || [])[1] || null,
    type,
    typeLabel,
    summary: summary ? decodeEntities(summary[1]).trim() : '',
    genres: genres ? decodeEntities(genres[1]).trim() : '',
    subtitles,
    relatedWorks: parseRelatedWorks(text),
  };
}

export function parseDetailPage(html) {
  const text = collapse(html);
  const h1 = cleanText((text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '');
  const posterTag = (text.match(/<img class="w-100"[^>]*>/) || [])[0] || '';
  const tagsHtml =
    (text.match(/<div class="float-start subtitle-metadata-tags">([\s\S]*?)<\/div>/) || [])[1] || '';
  const statsHtml =
    (text.match(/<div class="float-end subtitle-metadata-stats">([\s\S]*?)<\/div>/) || [])[1] || '';
  const metrics = [...statsHtml.matchAll(/<span class=['"]align-text-top me-3['"]>([^<]*)<\/span>/g)]
    .map((match) => cleanText(match[1]));

  const typeMatch = text.match(
    /<span class="bg-(?:primary|danger|success|warning|info|secondary) py-1 px-2 rounded-pill text-white">([^<]+)<\/span>/,
  );
  const typeLabel = typeMatch ? decodeEntities(typeMatch[1]).trim() : null;

  return {
    workId: (text.match(/<a class="me-1 link-dark" href="\/d\/(\d+)"/) || [])[1] || null,
    workName: h1.replace(/\s*\(\d{4}\)\s*$/, '').trim(),
    year: Number((h1.match(/\((\d{4})\)/) || [])[1]) || null,
    imdbId: (text.match(/imdb\.com\/title\/(tt\d+)/) || [])[1] || null,
    doubanId: (text.match(/movie\.douban\.com\/subject\/(\d+)/) || [])[1] || null,
    poster: (posterTag.match(/src="([^"]+)"/) || [])[1] || null,
    posterAlt: decodeEntities((posterTag.match(/alt="([^"]*)"/) || [])[1] || ''),
    type: typeLabel === '电影' ? 'movie' : typeLabel ? 'series' : null,
    typeLabel,
    edition: cleanText(
      (text.match(/<div class="f16 fw-bold mb-2 subtitle-edition">([\s\S]*?)<\/div>/) || [])[1] || '',
    ),
    badge: cleanText(
      (tagsHtml.match(/<span class="rounded p-1 me-1 text-white"[^>]*>([^<]*)<\/span>/) || [])[1] || '',
    ),
    languages: [...tagsHtml.matchAll(/<span class="p-1 fw-bold">([^<]+)<\/span>/g)].map((match) =>
      cleanText(match[1]),
    ),
    formats: [...tagsHtml.matchAll(/<span class="p-1 text-secondary">([^<]+)<\/span>/g)].map((match) =>
      cleanText(match[1]),
    ),
    sizeText: metrics[0] || null,
    downloads: Number(String(metrics[1] || '').replace(/[^\d]/g, '')) || 0,
    publishedAt: (text.match(/<time datetime="([^"]+)"/) || [])[1] || null,
    uploader: cleanText((text.match(/\/u\/[^'"]+['"][^>]*>([^<]*)<\/a>/) || [])[1] || ''),
  };
}

export function parseVideoId(id) {
  const parts = String(id ?? '').split(':');
  const imdbId = parts[0] || null;
  if (parts.length >= 3) {
    return { imdbId, season: Number(parts[1]) || null, episode: Number(parts[2]) || null };
  }
  if (parts.length === 2) {
    return { imdbId, season: null, episode: Number(parts[1]) || null };
  }
  return { imdbId, season: null, episode: null };
}

export function detectEpisodeInText(text, season, episode) {
  const haystack = String(text ?? '').toUpperCase();
  if (!episode) return false;

  const episodePatterns = [
    new RegExp(`S0*${season}\\s*[EЕ]0*${episode}(?![0-9])`),
    new RegExp(`(?<![0-9])0*${season}X0*${episode}(?![0-9])`),
    new RegExp(`(?<![0-9])E(?:P|PISODE)?\\.?\\s?0*${episode}(?![0-9])`),
  ];
  if (season && episodePatterns.some((pattern) => pattern.test(haystack))) return true;

  if (episodePatterns.slice(1).some((pattern) => pattern.test(haystack))) return true;

  const chinesePattern = new RegExp(`第\\s*0*${episode}\\s*集`);
  return chinesePattern.test(String(text ?? ''));
}
