// 「把视频文件名清洗成可以拿去搜字幕的关键词」。
//
// 思路来自 EasySub（macOS 上同时接了迅雷 / 射手 / SubHD 的开源工具）的 AssrtSearchQuery：
// 用户正在看的那个文件的文件名，比 Cinemeta 给的片名准得多 —— 里面有年份、季集号，
// 而且和字幕站的命名习惯一致。把 1080p / BluRay / x264 / -GROUP 这些技术尾巴去掉，
// 留下「片名 + 年份 + S01E01」，拿去搜命中率高得多。
//
// 例：
//   The.Greatest.S01E01.Fools.Gold.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb.mkv
//   → "The Greatest S01E01"（去掉画质/来源/编码/组名）
//   [zmk.pw]沙丘2.Dune.Part.Two.2024.2160p.BluRay.x265-ABC.mkv
//   → "沙丘2 Dune Part Two 2024"

const VIDEO_EXTS = new Set([
  'mkv', 'mp4', 'avi', 'mov', 'm4v', 'wmv', 'flv', 'webm', 'ts', 'm2ts', 'mpg', 'mpeg', 'iso', 'rmvb', 'vob',
]);

// 技术标记：出现这些词就把它和它后面的都当尾巴切掉（参考 EasySub 的 marker 正则）
const TECH_MARKER =
  /(?<![a-z0-9])(?:2160p|1080p|720p|576p|480p|4k|8k|uhd|imax|extended|uncut|remastered|theatrical|repack|proper|remux|bluray|blu-ray|bdrip|brrip|web[.\s_-]?dl|webrip|hdtv|dvdrip|hdcam|hdrip|x26[45]|h[.\s_-]?26[45]|hevc|avc|av1|10bit|8bit|12bit|hdr10\+?|hdr|dolby[.\s_-]?vision|dovi|atmos|truehd|dts(?:[.\s_-]?hd)?|ddp|dd[.\s]?[257]|ac3|eac3|aac|flac|opus|chs|cht|eng|bilingual|dual[.\s_-]?audio|multi[.\s_-]?(?:audio|sub|lang)|中字|双语|国语|粤语|简体|繁体|简中|繁中)(?![a-z0-9])/i;

/**
 * 视频文件名 → 搜索关键词。不是视频文件名时返回空串。
 * @param {string} filename
 * @returns {string}
 */
export function searchQueryFromFilename(filename) {
  const raw = String(filename || '').trim();
  if (!raw) return '';

  const dot = raw.lastIndexOf('.');
  const ext = dot >= 0 ? raw.slice(dot + 1).toLowerCase() : '';
  // 只处理真正的视频文件名：字幕站返回的 .srt 之类不进来
  if (!VIDEO_EXTS.has(ext)) return '';

  let name = raw.slice(0, dot);
  // 开头方括号 / 【】里的组名（[zmk.pw]、【电影】）
  name = name.replace(/^\s*\[[^\]]+\]\s*/, '').replace(/^\s*【[^】]+】\s*/, '');
  // 年份 / 季集后面紧跟的发布组（"2024-ABC" → "2024"）
  name = name.replace(/((?:19|20)\d{2})-[a-z0-9]{2,}$/i, '$1');
  name = name.replace(/((?:s\d{1,2}e\d{1,3}|\d{1,2}x\d{1,3}))-[a-z0-9]{2,}$/i, '$1');

  // 从第一个技术标记处截断
  const marker = name.search(TECH_MARKER);
  let stem = marker > 0 ? name.slice(0, marker) : name;

  // 后面剩下的部分**不要**：集标题会把搜索带偏。
  //   实测 `The Greatest S01E01 Fools Gold` → 迅雷按「Fools」匹配回
  //   《house of fools》《Only Fools and Horses》；而加季集号也不一定更好
  //   （`The Greatest S01E01` 会把片名正好叫 "The Greatest" 的那 14 条挤掉）。
  //   所以只交「片名 + 年份」，季集号交给本地判定 —— 搜索用最宽的词，筛选用最严的规则。
  const yearMatch = stem.match(/(?<!\d)(19|20)\d{2}(?!\d)/);
  if (yearMatch && yearMatch.index > 0) {
    // 有年份：截到年份（`Dune Part Two 2024`）—— 年份是最强的判别依据
    stem = stem.slice(0, yearMatch.index + 4);
  } else {
    // 没年份：截到季集号（`The Greatest S01E01`），后面的集标题会带偏搜索
    const episode = stem.match(/\b(S\d{1,2}[\s._-]*E\d{1,3}|\d{1,2}x\d{1,3})\b/i);
    if (episode && episode.index > 0) stem = stem.slice(0, episode.index + episode[0].length);
  }

  // 点/下划线换成空格，多余空格合并
  return stem.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 文件名里有没有季集号（S01E02 / 1x02 / 第3集） */
export function episodeFromFilename(filename) {
  const text = String(filename || '');
  let match = text.match(/\bS(\d{1,2})[\s._-]*E(\d{1,3})\b/i);
  if (match) return { season: Number(match[1]), episode: Number(match[2]) };
  match = text.match(/\b(\d{1,2})x(\d{1,3})\b/);
  if (match) return { season: Number(match[1]), episode: Number(match[2]) };
  match = text.match(/第\s*(\d{1,3})\s*[集话話]/);
  if (match) return { season: null, episode: Number(match[1]) };
  return { season: null, episode: null };
}

/** 文件名里的年份 */
export function yearFromFilename(filename) {
  return Number(String(filename || '').match(/(?<!\d)((?:19|20)\d{2})(?!\d)/)?.[1]) || null;
}
