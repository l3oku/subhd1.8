import http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ADDON_VERSION, config } from './config.js';
import {
  buildManifest,
  catalogHandler,
  languageText,
  preferredExt,
  subtitlesHandler,
} from './addon.js';
import { fromBase64url, isThunderEnabled } from './thunder.js';
import { assrtArchive, assrtById, assrtDownloadHref, isAssrtEnabled, searchAssrt } from './assrt.js';
import { extOfName, extractLangTag, fetchSingleSubtitle, isImageExt, isSingleSubtitle, loadSingle, subtitleFromInput } from './files.js';
import { networkReport } from './diagnostics.js';
import { sourcesHealth } from './health.js';
import {
  AppError,
  client,
  fetchRemoteFile,
  getSubtitleBinary,
  getSubtitleDetail,
  getSubtitleText,
  rateLimitState,
  search,
  warmSubtitles,
} from './subhd.js';
import { LOGO_SVG, landingPage } from './web.js';
import { SUBTITLE_MIME } from './subtitle-format.js';
import { log } from './log.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
};

function resolveBaseUrl(req) {
  if (config.baseUrl) return config.baseUrl;
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProto || (req.socket.encrypted ? 'https' : 'http');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || `localhost:${config.port}`)
    .split(',')[0]
    .trim();
  return `${protocol}://${host}`;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...CORS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendText(res, status, body, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(status, {
    ...CORS,
    'content-type': contentType,
    'content-length': payload.length,
    ...extraHeaders,
  });
  res.end(payload);
}

// Vercel 的函数对「先攒好、再一次性返回」的响应有 4.5MB 硬上限（超过就是 413
// FUNCTION_PAYLOAD_TOO_LARGE），这个上限调不了；官方给的绕法就是流式返回 —— 分块写出去的
// 响应不算这个上限。图形字幕（一部片子几十 MB）和 /raw 的原始压缩包都走这条路：不设
// content-length，HTTP/1.1 自己用 chunked。
const STREAM_CHUNK_BYTES = 512 * 1024;
// 攒着发就会 413 的线，留在 4.5MB 下面一点
const VERCEL_PAYLOAD_LIMIT = 4 * 1024 * 1024;

async function sendStreamed(res, status, payload, contentType = 'application/octet-stream', extraHeaders = {}) {
  res.writeHead(status, {
    ...CORS,
    'content-type': contentType,
    ...extraHeaders,
  });

  function* chunks() {
    for (let offset = 0; offset < payload.length; offset += STREAM_CHUNK_BYTES) {
      yield payload.subarray(offset, offset + STREAM_CHUNK_BYTES);
    }
  }

  try {
    await pipeline(Readable.from(chunks()), res);
  } catch (error) {
    // 客户端中途断开（换字幕、关掉播放器）会连 socket 一起断，不算服务端出错
    if (!res.destroyed && !res.writableEnded) throw error;
  }
}

function parseExtra(segment) {
  const extra = {};
  if (!segment) return extra;
  for (const part of String(segment).split('&')) {
    if (!part) continue;
    const index = part.indexOf('=');
    if (index < 0) {
      extra[decodeURIComponent(part)] = true;
      continue;
    }
    const key = decodeURIComponent(part.slice(0, index));
    const value = decodeURIComponent(part.slice(index + 1).replace(/\+/g, ' '));
    extra[key] = value;
  }
  return extra;
}

// Vercel rewrites every path to the single `/api/index` function, so the
// original path travels along as a query parameter (see vercel.json).
export const REWRITE_PATH_PARAM = '__subhd_path';
const FUNCTION_PATHS = new Set(['/api', '/api/index', '/api/index.js', '/api/index.mjs']);

export function resolvePathname(url) {
  const injected = url.searchParams.get(REWRITE_PATH_PARAM);
  url.searchParams.delete(REWRITE_PATH_PARAM);
  const raw = injected && FUNCTION_PATHS.has(url.pathname) ? injected.split('?')[0] : url.pathname;
  return raw.replace(/\/+$/, '') || '/';
}

export async function handle(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = resolvePathname(url);
  const baseUrl = resolveBaseUrl(req);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    sendText(res, 200, landingPage({ baseUrl }), 'text/html; charset=utf-8');
    return;
  }

  if (pathname === '/healthz') {
    // commit 是排障用的：确认线上跑的是哪一次提交（Vercel 自己注入这个环境变量）
    // rateLimit 是给「点了没反应」用的：能看出站点是不是在按出口 IP 限流（见 README）
    const rateLimit = rateLimitState();
    sendJson(res, 200, {
      ok: true,
      version: ADDON_VERSION,
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || null,
      domain: client.domain,
      rateLimit: {
        cooldownMs: rateLimit.remainingMs,
        intervalMs: rateLimit.intervalMs,
        hits: rateLimit.hits,
      },
      // 配了 SUBHD_PROXIES 的话：几个出口、几个在冷却、每个被拍过几次（见 README）
      proxy: rateLimit.proxy,
      // 迅雷 / 射手（伪）最近是否连不上（见 health.js）：哪个来源在看、快多久恢复
      sources: sourcesHealth(),
    });
    return;
  }

  if (pathname === '/debug/net') {
    sendJson(res, 200, await networkReport({ exits: url.searchParams.get('exits') === '1' }));
    return;
  }

  if (pathname === '/assets/logo.svg') {
    sendText(res, 200, LOGO_SVG, 'image/svg+xml; charset=utf-8', { 'cache-control': 'public, max-age=86400' });
    return;
  }

  if (pathname === '/manifest.json') {
    sendJson(res, 200, buildManifest(baseUrl));
    return;
  }

  const catalogMatch = pathname.match(/^\/catalog\/([^/]+)\/([^/]+)(?:\/(.+?))?\.json$/);
  if (catalogMatch) {
    const [, type, id, extraSegment] = catalogMatch;
    const extra = { ...parseExtra(extraSegment), ...Object.fromEntries(url.searchParams) };
    const body = await catalogHandler({ type, id: decodeURIComponent(id), extra });
    sendJson(res, 200, body);
    return;
  }

  // /subtitles/<type>/<id>.json —— 三个来源（SubHD / 迅雷 / 射手伪）合在一个列表里返回。
  // Stremio 客户端只会请求这一个资源名（见 addon.js 的 buildManifest），所以老地址不变。
  // 调试时可以带 ?source=thunder 只看某一个站。
  const subtitleMatch = pathname.match(/^\/subtitles\/([^/]+)\/(.+?)\.json$/);
  if (subtitleMatch) {
    const [, type, rest] = subtitleMatch;
    const [rawId, extraSegment] = rest.split('/');
    const extra = { ...parseExtra(extraSegment), ...Object.fromEntries(url.searchParams) };
    const source = String(url.searchParams.get('source') || '').trim() || null;
    const body = await subtitlesHandler({ type, id: decodeURIComponent(rawId), extra }, baseUrl, source);
    sendJson(res, 200, body);
    return;
  }

  const fileMatch = pathname.match(/^\/sub\/([A-Za-z0-9]+)\.(srt|ass|ssa|vtt|txt|sup)$/);
  if (fileMatch) {
    const [, sid, ext] = fileMatch;
    const season = Number(url.searchParams.get('s')) || null;
    const episode = Number(url.searchParams.get('e')) || null;
    // 简中 / 繁中 / 日语……同一条字幕的不同语言各是一条轨道，靠它挑包里对应的文件
    const lang = String(url.searchParams.get('lang') || '').trim() || null;
    // 列表里排在它下面的那两条（客户端点谁就带谁），提前下好，换字幕时不用等
    const warm = String(url.searchParams.get('warm') || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    // 图形字幕（SUP/PGS）没有文本可转：原样把图片字幕发出去，交给会画图片的播放器
    const isImage = ext === 'sup';
    const result = isImage
      ? await getSubtitleBinary(sid, { season, episode, lang })
      : await getSubtitleText(sid, {
          targetExt: ext === 'ssa' ? 'ass' : ext,
          season,
          episode,
          lang,
        });
    warmSubtitles(warm.filter((candidate) => candidate !== sid));
    const filename = `${sid}.${result.ext}`;
    const headers = {
      'cache-control': 'public, max-age=600',
      'content-disposition': `inline; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(result.sourceName || filename)}`,
      'x-subhd-container': result.container || 'text',
      'x-subhd-language': result.language || 'auto',
      'x-subhd-episode-match': String(Boolean(result.matchedEpisode)),
    };
    if (isImage) {
      // 「假包」没有图片字幕，只有一份网盘说明：这时把说明当文本字幕发出去，用户至少能在
      // 画面里看到链接 —— 失败的响应体 Stremio 根本不显示，用户只会觉得「点了没反应」。
      if (result.note) {
        sendText(res, 200, result.text, SUBTITLE_MIME.srt, { ...headers, 'x-subhd-note': '1' });
        return;
      }
      // 一整部片子的 PGS 常常几十 MB，攒着发回给 Vercel 只会撞 4.5MB 上限
      await sendStreamed(res, 200, result.data, SUBTITLE_MIME.sup, { ...headers, 'x-subhd-image': '1' });
      return;
    }
    // 带特效的 ASS 也有长到几 MB 的，同样别攒着发
    const text = Buffer.from(result.text, 'utf8');
    if (text.length > VERCEL_PAYLOAD_LIMIT) {
      await sendStreamed(res, 200, text, SUBTITLE_MIME[result.ext] || 'text/plain; charset=utf-8', {
        ...headers,
        'sub-encoding': 'UTF-8',
      });
      return;
    }
    sendText(res, 200, result.text, SUBTITLE_MIME[result.ext] || 'text/plain; charset=utf-8', {
      ...headers,
      'sub-encoding': 'UTF-8',
    });
    return;
  }

  // 迅雷：列表里给的是 /thunder/<base64url(直链)>.<ext>，点开时才由这台服务器去 CDN 取
  //（Vercel 上 CDN 经常连不上；取回来还要统一转 UTF-8，见 files.js）。
  const thunderMatch = pathname.match(/^\/thunder\/([A-Za-z0-9_-]+)\.(srt|ass|ssa|vtt|sup)$/);
  if (thunderMatch) {
    const [, encoded, ext] = thunderMatch;
    if (!isThunderEnabled()) throw new AppError('迅雷这个来源没有启用', 404);
    const fileUrl = fromBase64url(encoded);
    if (!/^https?:\/\//.test(fileUrl)) throw new AppError('无效的字幕地址', 400);
    const file = await fetchSingleSubtitle(fileUrl, { referer: 'https://www.xunlei.com/', ext });
    const headers = {
      'cache-control': 'public, max-age=600',
      'content-disposition': `inline; filename="${encodeURIComponent(encoded.slice(0, 24))}.${ext}"`,
      'x-subhd-container': 'text',
      'x-subhd-language': extractLangTag(fileUrl) || 'auto',
    };
    if (ext === 'sup') {
      await sendStreamed(res, 200, file.data, SUBTITLE_MIME.sup, { ...headers, 'x-subhd-image': '1' });
      return;
    }
    const result = subtitleFromInput({ kind: 'single', data: file.data, ext, filename: `thunder.${ext}` }, {
      targetExt: ext === 'ssa' ? 'ass' : ext,
    });
    const text = Buffer.from(result.text, 'utf8');
    const type = SUBTITLE_MIME[result.ext] || 'text/plain; charset=utf-8';
    if (text.length > VERCEL_PAYLOAD_LIMIT) {
      await sendStreamed(res, 200, text, type, { ...headers, 'sub-encoding': 'UTF-8' });
      return;
    }
    sendText(res, 200, result.text, type, { ...headers, 'sub-encoding': 'UTF-8' });
    return;
  }

  // 射手（伪）：列表里给的是 /assrt/<编号>.srt?lang=zh…，点开才去射手取（可能是压缩包，
  // 按语言挑一份），编码统一成 UTF-8 再发出去（见 assrt.js / files.js）。
  const assrtMatch = pathname.match(/^\/assrt\/(\d+)\.(srt|ass|ssa|vtt|sup)$/);
  if (assrtMatch) {
    const [, id, ext] = assrtMatch;
    const season = Number(url.searchParams.get('s')) || null;
    const episode = Number(url.searchParams.get('e')) || null;
    const lang = String(url.searchParams.get('lang') || '').trim() || null;
    const result = await assrtTrack({ id, ext, season, episode, lang });
    const filename = `${id}.${result.ext}`;
    const headers = {
      'cache-control': 'public, max-age=600',
      'content-disposition': `inline; filename="${filename}"`,
      'x-subhd-container': result.container || 'text',
      'x-subhd-language': result.language || 'auto',
    };
    if (Buffer.isBuffer(result.data)) {
      await sendStreamed(res, 200, result.data, SUBTITLE_MIME.sup, { ...headers, 'x-subhd-image': '1' });
      return;
    }
    const text = Buffer.from(result.text, 'utf8');
    const type = SUBTITLE_MIME[result.ext] || 'text/plain; charset=utf-8';
    if (text.length > VERCEL_PAYLOAD_LIMIT) {
      await sendStreamed(res, 200, text, type, { ...headers, 'sub-encoding': 'UTF-8' });
      return;
    }
    sendText(res, 200, result.text, type, { ...headers, 'sub-encoding': 'UTF-8' });
    return;
  }

  const rawMatch = pathname.match(/^\/raw\/([A-Za-z0-9]+)$/);
  if (rawMatch) {
    const [, sid] = rawMatch;
    const { raw, filename } = await fetchRemoteFile(sid);
    await sendStreamed(res, 200, raw, 'application/octet-stream', {
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'private, max-age=300',
    });
    return;
  }

  if (pathname === '/api/search') {
    const keyword = String(url.searchParams.get('q') || '').trim();
    const page = Number(url.searchParams.get('page') || 1) || 1;
    const source = new URLSearchParams(url.search).get('source');
    if (source && source !== 'subhd') {
      sendJson(res, 200, await sourceSearch(source, keyword));
      return;
    }
    const result = await search(keyword, { page });
    const entries = result.entries.slice(0, 40).map((entry) => ({
      ...entry,
      languageText: languageText(entry),
      downloadUrl: `/sub/${entry.sid}.${preferredExt(entry)}`,
      rawUrl: `/raw/${entry.sid}`,
      pageUrl: client.url(`/a/${entry.sid}`),
    }));
    sendJson(res, 200, { total: result.total, page: result.page, entries });
    return;
  }

  const detailMatch = pathname.match(/^\/api\/entry\/([A-Za-z0-9]+)$/);
  if (detailMatch) {
    sendJson(res, 200, await getSubtitleDetail(detailMatch[1]));
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

// 射手（伪）的一条轨道：取回来 → 按语言 / 集号挑一份 → 转 UTF-8。
// 取不到时给一句人话（用户至少知道是站点不通，而不是插件坏了）。
async function assrtTrack({ id, ext, season, episode, lang }) {
  if (!isAssrtEnabled()) throw new AppError('射手（伪）这个来源没有启用', 404);
  // 列表里没把下载地址写进 url（太长），点开时按编号再查一次详情
  const item = await assrtById(id);
  if (!assrtDownloadHref(item) && !item.filelist?.length) {
    throw new AppError(`射手（伪）上这条字幕（${id}）已经没有下载地址了，请换一条`, 502);
  }
  const target = ext === 'ssa' ? 'ass' : ext;
  if (isSingleSubtitle(item.filename || item.downloadHref || '', target)) {
    const href = assrtDownloadHref(item);
    const reference = href ? `https://${item.domain || config.assrt.domains[0]}${href}` : '';
    const file = await loadSingle(`assrt:${id}`, async () => {
      // 单个文件直接用 fetchBinary 取（带 302），别再走解压
      const { fetchBinary } = await import('./net.js');
      return fetchBinary(reference, {
        maxBytes: 128 * 1024 * 1024,
        timeoutMs: 40_000,
        referer: `https://${item.domain || config.assrt.domains[0]}/`,
      });
    });
    if (isImageExt(extOfName(item.filename || reference, ext))) {
      return { data: file, ext: 'sup', container: 'text', language: lang };
    }
    return subtitleFromInput({ kind: 'single', data: file }, { targetExt: target, lang, season, episode });
  }

  const archive = await assrtArchive(item);
  return subtitleFromInput({ kind: 'archive', archive }, { targetExt: target, lang, season, episode });
}

async function sourceSearch(source, keyword) {
  if (source === 'thunder') {
    const { searchThunder, thunderSearchFallback } = await import('./thunder.js');
    let items;
    try {
      items = await searchThunder(keyword);
      // 迅雷的索引挂的是「条目名」：中文片名经常搜不到，但它的英文名一搜就是一堆中文文件
      // （搜「奥德赛」0 条，搜「The Odyssey」57 条全叫「奥德赛.srt」）。中文没结果就换英文再搜。
      if (items.length === 0) items = await thunderSearchFallback(keyword);
    } catch (error) {
      // 迅雷接口在部分机房/网络连不上：给一句人话，别把「This operation was aborted」丢给用户
      throw new AppError(
        `迅雷字幕接口连不上（多半是这台服务器到迅雷的网络被挡住了），换个来源试试：${error.message}`,
        502,
      );
    }
    return {
      source,
      total: items.length,
      entries: items.slice(0, 40).map((item, index) => ({
        title: item.simple_name || item.name,
        filename: item.name,
        // 首页的「下载字幕」走插件自己的 /thunder 路由（服务器替用户取，并转成 UTF-8）
        downloadUrl: item.url,
        rawUrl: item.url,
        serverFile: `/thunder/${Buffer.from(String(item.url), 'utf8').toString('base64url')}.${String(item.ext || 'srt').toLowerCase()}`,
        index,
        languages: item.languages || [],
        formats: item.ext ? [String(item.ext).toUpperCase()] : [],
        pageUrl: `${config.thunder.apiBase}`,
      })),
    };
  }
  if (source === 'assrt') {
    let found;
    try {
      found = await searchAssrt(keyword);
    } catch (error) {
      throw new AppError(`射手（伪）连不上，稍后再试或换个来源：${error.message}`, 502);
    }
    const { items, total } = found;
    return {
      source,
      total,
      entries: items.slice(0, 40).map((item, index) => ({
        title: item.title,
        filename: item.filename,
        index,
        languages: item.languages ? [item.languages] : [],
        formats: item.format ? [item.format] : [],
        downloadUrl: item.downloadHref ? `https://${config.assrt.domains[0]}${item.downloadHref}` : null,
        // 射手（伪）的「下载字幕」也走插件自己的路由：压缩包里按语言挑一份，编码统一成 UTF-8
        serverFile: `/assrt/${item.id}.srt`,
        pageUrl: `https://${config.assrt.domains[0]}/xml/sub/${Math.floor(Number(item.id) / 1000)}/${item.id}.xml`,
      })),
    };
  }
  return { source, total: 0, entries: [] };
}

// Shared by the standalone server and the serverless entry point (api/index.js).
export async function dispatch(req, res) {
  const started = Date.now();
  try {
    await handle(req, res);
  } catch (error) {
    const status = error instanceof AppError ? error.status : 500;
    log('error', req.method, req.url, error.message);
    if (res.headersSent) {
      res.end();
      return;
    }
    const pathname = resolvePathname(new URL(req.url || '/', 'http://localhost'));
    const wantsPlain = /^\/(sub|raw)\//.test(pathname);
    if (wantsPlain) {
      sendText(res, status === 503 ? 503 : 502, `${error.message || '字幕获取失败'}\n`);
    } else {
      sendJson(res, status, { error: error.message || 'Internal error' });
    }
  } finally {
    if (config.logLevel === 'debug') log(req.method, req.url, res.statusCode, `${Date.now() - started}ms`);
  }
}

export function startServer() {
  const server = http.createServer((req, res) => {
    dispatch(req, res);
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  server.listen(config.port, config.host, () => {
    const host = config.host === '0.0.0.0' ? 'localhost' : config.host;
    log(`SubHD Stremio addon v${ADDON_VERSION} listening on http://${host}:${config.port}`);
    log(`Install: http://${host}:${config.port}/manifest.json`);
  });

  return server;
}
