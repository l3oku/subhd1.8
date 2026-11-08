// 「迅雷 / 射手（伪）的一条字幕」→ 取回来、挑出要看的那一份、转成 SRT/ASS 发给客户端。
//
// 和 SubHD 的 /sub/<sid> 是一个思路：列表里列的是「轨道」，点开才去取真正的文件。
// 为什么不让 Stremio 直接连迅雷 / 射手的 CDN（直链其实是公开的）：
//   - 这些站的 CDN 在国内网络下才快，Vercel 那台机器（hkg1）连它们有时根本不通；反过来，
//     用户自己的网络也可能被墙。由插件服务器统一去取，两边都能用上（也能缓存）。
//   - 迅雷 / 射手给的是「整包」（按语言分好几份文件），要按语言挑一份；直链没法表达这个。
//   - 编码也不统一（GBK / Big5 / UTF-16 都见过），统一转成 UTF-8 再发出去，播放器才不乱码。
import { extname } from 'node:path';
import { fetchBinary, logSource } from './net.js';
import { isProxyEnabled, proxyFetchBinary } from './proxy-cf.js';
import { AppError, getArchiveFilesFromBuffer, subtitleTextFromArchive } from './subhd.js';
import { TtlCache } from './cache.js';

const MAX_BYTES = 128 * 1024 * 1024;

// 已取回的原始文件（整包）：按「来源:编号」缓存 30 分钟
const rawCache = new TtlCache({
  ttlMs: 30 * 60 * 1000,
  maxEntries: 60,
  maxBytes: 160 * 1024 * 1024,
  sizeOf: (value) => value?.raw?.length || 0,
});
// 解压 / 挑文件的结果：同一个包换语言就不用再解一次
const filesCache = new TtlCache({
  ttlMs: 30 * 60 * 1000,
  maxEntries: 40,
  maxBytes: 160 * 1024 * 1024,
  sizeOf: (value) => (value?.files || []).reduce((total, file) => total + (file.data?.length || 0), 0),
});

// 「这条字幕本身就是一个文件」（srt/ass/ssa/vtt/sup），不用解压：按 url 缓存 30 分钟
const singleCache = new TtlCache({
  ttlMs: 30 * 60 * 1000,
  maxEntries: 120,
  maxBytes: 64 * 1024 * 1024,
  sizeOf: (value) => value?.data?.length || 0,
});

const SUBTITLE_EXTS = ['srt', 'ass', 'ssa', 'vtt', 'sup', 'sub'];

export function extOfUrl(url, fallback = 'srt') {
  const raw = String(url || '').split('?')[0];
  const ext = extname(raw).replace('.', '').toLowerCase();
  if (SUBTITLE_EXTS.includes(ext)) return ext;
  // 迅雷的直链以 .srt / .ass 结尾；射手（伪）的下载链接文件名在后面（可能被 URL 编码）
  const decoded = (() => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  })();
  const decodedExt = extname(decoded).replace('.', '').toLowerCase();
  return SUBTITLE_EXTS.includes(decodedExt) ? decodedExt : fallback;
}

/** 一个 url 是不是「单个字幕文件」（而不是压缩包） */
// 压缩包扩展名：遇到这些就是「整包」，别再往里猜字幕格式
const ARCHIVE_EXTS = ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz'];

function lastExt(value) {
  return extname(String(value || '').split('?')[0]).replace('.', '').toLowerCase();
}

// 「这个名字 / url 的扩展名」：优先看文件本身的扩展名，没有再看 url。
// 压缩包返回 'zip' 之类的原样值，交给调用方判断。
export function extOfName(name, fallback = 'srt') {
  const fromName = lastExt(name);
  if (SUBTITLE_EXTS.includes(fromName) || ARCHIVE_EXTS.includes(fromName)) return fromName;
  return extOfUrl(name, fallback);
}

// 这个 url / 文件名是不是「一份字幕」（而不是压缩包）：射手（伪）那边要靠它决定
// 走「直接取文件」还是「取回来解压」。
export function isSingleSubtitle(url, fallbackExt = '') {
  const ext = extOfName(url, fallbackExt);
  return SUBTITLE_EXTS.includes(ext);
}

export function isImageExt(ext) {
  return String(ext).toLowerCase() === 'sup' || String(ext).toLowerCase() === 'pgs';
}

/**
 * 把「一个字幕文件」取回来（带缓存）。
 * @returns {Promise<{ data: Buffer, ext: string, url: string }>}
 */
export async function fetchSingleSubtitle(url, { referer = '', ext = '' } = {}) {
  const key = `file:${url}`;
  const hit = singleCache.get(key);
  if (hit) return hit;
  // 迅雷的字幕文件在它自己的 CDN 上，和接口一样从机房连经常不通：配了代理就走代理。
  const data = isProxyEnabled()
    ? await proxyFetchBinary(url, { timeoutMs: 25_000, maxBytes: MAX_BYTES })
    : await fetchBinary(url, { referer, maxBytes: MAX_BYTES, timeoutMs: 40_000 });
  const value = { data, ext: ext || extOfUrl(url), url };
  singleCache.set(key, value);
  return value;
}

/**
 * 「这条字幕本身就是一个文件」（不是压缩包）：按编号缓存回来。
 * @param {string} id  缓存的键
 * @param {() => Promise<Buffer>} load 真正去下载的逻辑
 */
export async function loadSingle(id, load) {
  const key = `single:${id}`;
  const cached = singleCache.get(key);
  if (cached) return cached.data;
  const data = await load();
  if (!data || data.length === 0) throw new AppError('下载到的字幕文件是空的，请换一条', 502);
  if (looksLikeErrorPage(data)) {
    throw new AppError('射手（伪）这次返回的是报错页面（站点在限流或那条下载链接失效了），换一条或稍后再试', 502);
  }
  singleCache.set(key, { data });
  return data;
}

/**
 * 把「一个压缩包」取回来并解开（带缓存）。
 * @param {string} id   缓存的键（来源 + 站点编号）
 * @param {() => Promise<{ raw: Buffer, filename: string }>} load 真正去下载的逻辑
 */
// 射手（伪）在出错时也回 200，正文是 XML 报错页（java.money.noMoneyException），或者直接
// 是一张 HTML 页面。把它当成「文件」发出去用户只会看到乱码，所以取回来先看一眼。
const ERROR_PAGE_RE = /^\s*(<\?xml|<html|<!doctype html|<head)/i;

export function looksLikeErrorPage(buffer) {
  if (!buffer || buffer.length > 256 * 1024) return false;
  return ERROR_PAGE_RE.test(buffer.subarray(0, 512).toString('utf8'));
}

export async function loadArchive(id, load) {
  const key = `archive:${id}`;
  const cached = filesCache.get(key);
  if (cached) return cached;

  let rawEntry = rawCache.get(key);
  if (!rawEntry) {
    rawEntry = await load();
    if (!rawEntry || !rawEntry.raw || rawEntry.raw.length === 0) {
      throw new AppError('下载到的字幕文件是空的，请换一条', 502);
    }
    if (looksLikeErrorPage(rawEntry.raw)) {
      throw new AppError('射手（伪）这次返回的是报错页面（站点在限流或那条下载链接失效了），换一条或稍后再试', 502);
    }
    rawCache.set(key, rawEntry);
  }

  const archive = await getArchiveFilesFromBuffer(rawEntry.raw, rawEntry.filename);
  filesCache.set(key, archive);
  return archive;
}

/**
 * 包 / 单文件 → 一份文本字幕。
 * @param {{ kind: 'single' | 'archive', data?: Buffer, archive?: object, filename?: string }} input
 */
export function subtitleFromInput(input, { targetExt = 'srt', lang = null, season = null, episode = null } = {}) {
  if (input.kind === 'single') {
    const name = input.filename || `subtitle.${input.ext || 'srt'}`;
    const archive = { container: 'text', filename: name, tool: null, files: [{ name, data: input.data }] };
    return subtitleTextFromArchive(archive, { targetExt, lang, season, episode });
  }
  return subtitleTextFromArchive(input.archive, { targetExt, lang, season, episode });
}

// 迅雷的文件名里常常带语言标记（.chs. / .cht. / .简中. / .繁.），取回来之后第二行能用上
export function extractLangTag(url) {
  const name = (() => {
    try {
      return decodeURIComponent(String(url || '').split('?')[0]);
    } catch {
      return String(url || '');
    }
  })();
  if (/(^|[._\-/])(chs|sc|gb|zh-cn|zh-hans|简|簡)([._\-/]|$)/i.test(name)) return 'zh-Hans';
  if (/(^|[._\-/])(cht|tc|big5|zh-tw|zh-hant|繁)([._\-/]|$)/i.test(name)) return 'zh-Hant';
  if (/(^|[._\-/])(eng|en)([._\-/]|$)/i.test(name)) return 'en';
  return null;
}

export { MAX_BYTES };
