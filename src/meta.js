// Cinemeta（Stremio 官方的影片元数据服务）：tt… → 片名 / 年份 / 类型。
//
// 迅雷字幕只认片名，射手（伪）的网页搜索也主要靠片名，所以两边都先来这里换一个
// 人话的名字。Cinemeta 给的是英文原名；中文名这里没有，得靠 Stremio 送来的
// 文件名或用户在目录里搜的关键词（见 addon.js 的 catalog）。
import { TtlCache } from './cache.js';
import { fetchText, logSource } from './net.js';

const CINEMETA = 'https://v3-cinemeta.strem.io';
const metaCache = new TtlCache({ ttlMs: 6 * 60 * 60 * 1000, maxEntries: 500 });

/**
 * 「名字 → Cinemeta 条目」。最新字幕列表里的条目只有一个名字（可能还带着原名和年份），
 * 拿它换一个 tt 编号，Stremio 点进去才是正经的影片页。
 */
export async function searchMeta(type, query, { year = null } = {}) {
  const kind = String(type) === 'series' ? 'series' : 'movie';
  const text = String(query || '').trim();
  if (!text) return null;
  const key = `cinemeta-search:${kind}:${text.toLowerCase()}:${year || ''}`;
  // Cinemeta 的排序对年份不敏感：搜「奥德赛」只会给 2016 那部，搜「奥德赛 2026」才把 2026 那条
  // 排到第一。所以年份要直接拼进查询词。
  const searchText = year ? `${text} ${year}` : text;

  return metaCache.wrap(key, async () => {
    try {
      const url = `${CINEMETA}/catalog/${kind}/top/search=${encodeURIComponent(searchText)}.json`;
      const response = await fetchText(url, { accept: 'application/json', timeoutMs: 8000 });
      if (!response.ok) return null;
      const body = JSON.parse(response.text);
      const metas = Array.isArray(body?.metas) ? body.metas : [];
      const expected = normalizeName(text);
      const scored = metas
        .filter((meta) => meta && /^tt\d+$/.test(String(meta.id || '')))
        .map((meta) => {
          const name = normalizeName(meta.name);
          let score = 0;
          if (name === expected) score += 3;
          else if (name.includes(expected) || expected.includes(name)) score += 1;
          const metaYear = Number(String(meta.releaseInfo || '').match(/\d{4}/)?.[0]) || null;
          // 年份对得上最重要：同名不同年的片子（奥德赛 2026 / 2016）光看名字会选错
          if (year && metaYear === Number(year)) score += 5;
          else if (year && metaYear) score -= 2;
          return { meta, score };
        })
        .sort((a, b) => b.score - a.score);
      return scored[0]?.meta || null;
    } catch (error) {
      logSource('cinemeta', `搜索 ${text}: ${error.message}`);
      return null;
    }
  });
}

const normalizeName = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^\p{Script=Han}a-z0-9]+/gu, ' ')
    .trim();

export async function addonMeta(type, imdbId, { preferChinese = false } = {}) {
  const kind = String(type) === 'series' ? 'series' : 'movie';
  const id = String(imdbId || '');
  if (!/^tt\d+$/.test(id)) return null;

  // 片名查不到就全盘没有字幕，所以网络抖动时重试一次（Cinemeta 偶尔 TLS 握手失败）
  const fetchMeta = async () => {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await fetchText(`${CINEMETA}/meta/${kind}/${id}.json`, {
          accept: 'application/json',
          timeoutMs: 6000,
          tls13Only: false,
        });
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  };

  const meta = await metaCache.wrap(`cinemeta:${kind}:${id}`, async () => {
    try {
      const response = await fetchMeta();
      if (!response.ok) return null;
      const body = JSON.parse(response.text);
      const value = body?.meta;
      if (!value) return null;
      return {
        id: value.id,
        type: kind,
        name: value.name || value.originalName || '',
        originalName: value.originalName || '',
        releaseInfo: value.releaseInfo || '',
        // 中文名（有的条目带 translations / 中文 title）
        chineseName:
          value.name_translations?.zh?.name ||
          value.translations?.find?.((item) => /^zh/i.test(item.language || item.lang || ''))?.name ||
          '',
        genres: value.genres || [],
      };
    } catch (error) {
      logSource('cinemeta', `${kind}/${id}: ${error.message}`);
      return null;
    }
  });

  if (!meta) return null;
  if (preferChinese && meta.chineseName) return { ...meta, name: meta.chineseName };
  return meta;
}
