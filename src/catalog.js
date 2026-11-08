// 迅雷 / 射手（伪）两个来源的「发现页目录」：最新电影、最新剧集、按片名搜索。
//
// Stremio 的目录返回的是 meta 预览（id 必须是 tt 编号，点进去才能正常播放），
// 所以这里做两件事：
//   - 搜索：用户输入关键词 → 迅雷 / 射手的搜索结果 → 每个作品名去 Cinemeta 换成 tt；
//   - 最新：迅雷没有「最新」接口（它只按名字搜），最新列表只有射手（伪）有（/xml/list/sub/）。
import { TtlCache } from './cache.js';
import { searchMeta } from './meta.js';
import { logSource } from './net.js';
import { searchThunder } from './thunder.js';
import { parseSimpleName } from './thunder.js';
import { latestAssrt, searchAssrt, splitAssrtTitle } from './assrt.js';

const metaCache = new TtlCache({ ttlMs: 6 * 60 * 60 * 1000, maxEntries: 400 });

// 「简体[SRT]沙丘2(2024)」里的作品名 → { title, year }
function thunderWorkName(item) {
  const parsed = parseSimpleName(item.simple_name);
  return { title: parsed.work || String(item.name || '').replace(/\.[A-Za-z0-9]{1,4}$/, ''), year: parsed.year };
}

function toPreview(meta, type, extra = {}) {
  return {
    id: meta.id,
    type,
    name: meta.name || meta.originalName || meta.id,
    poster: meta.poster || undefined,
    posterShape: 'poster',
    releaseInfo: /^\d{4}/.test(String(meta.releaseInfo || '')) ? meta.releaseInfo : undefined,
    description: extra.description,
  };
}

// 每个作品名只换一次 tt 编号（Cinemeta 的搜索接口不快，别一个名字问两遍）
async function previewFor(type, name, year) {
  if (!name) return null;
  return metaCache.wrap(`preview:${type}:${name.toLowerCase()}:${year || ''}`, async () => {
    const meta = await searchMeta(type, name, { year });
    if (!meta) return null;
    return { meta, year };
  });
}

// 一次目录请求最多换几个 tt 编号：Cinemeta 一次 200~800ms，多了就超时了
const MAX_LOOKUPS = 12;
// 名字里「像片名」的那一段：太长的是完整发布名，短名字（一个词）像是随手起的文件名
const usableName = (title) => /[\p{Script=Han}]/u.test(title) ? title.length >= 2 && title.length <= 60 : title.length >= 3 && title.split(/\s+/).length <= 8;

export async function sourceCatalog({ type, source, kind, keyword = '', skip = 0 }) {
  const metas = [];
  const seen = new Set();
  const push = (preview) => {
    if (!preview || seen.has(preview.id)) return;
    seen.add(preview.id);
    metas.push(toPreview(preview.meta, type, {}));
  };

  if (kind === 'search') {
    if (!keyword) return metas;

    if (source === 'thunder') {
      const items = await searchThunder(keyword);
      const works = [];
      const seenWorks = new Set();
      for (const item of items) {
        const { title, year } = thunderWorkName(item);
        const key = `${title}|${year || ''}`;
        if (!title || !usableName(title) || seenWorks.has(key)) continue;
        seenWorks.add(key);
        works.push({ title, year });
        if (works.length >= MAX_LOOKUPS) break;
      }
      const previews = await Promise.all(works.map((work) => previewFor(type, work.title, work.year)));
      for (const preview of previews) push(preview);
      return metas;
    }

    // 射手（伪）：搜索结果里的标题通常就是「片名 原名 (年份)」
    const { items } = await searchAssrt(keyword);
    const works = [];
    const seenWorks = new Set();
    for (const item of items) {
      const { title, year } = splitAssrtTitle(item.title);
      const key = `${title}|${year || ''}`;
      if (!title || !usableName(title) || seenWorks.has(key)) continue;
      seenWorks.add(key);
      works.push({ title, year });
      if (works.length >= MAX_LOOKUPS) break;
    }
    const previews = await Promise.all(works.map((work) => previewFor(type, work.title, work.year)));
    for (const preview of previews) push(preview);
    return metas;
  }

  // 最新：只有射手（伪）有列表（迅雷只能按名字搜）。
  // 最新列表里混着电影和剧，而 Cinemeta 的片名搜索不知道类型 —— 同名的电影和剧会被
  // 搜成同一个 tt，所以先按名字里有没有 SxxExx 分出「像剧的 / 像电影的」，再按请求的
  // 类型去搜。一页最多换 8 个 tt，凑不满 20 条就顺着翻下一页（最多 3 页）。
  if (source !== 'assrt') return metas;
  const wanted = Number(skip) || 0;
  const firstPage = Math.floor(wanted / 20) + 1;

  for (let page = firstPage; page < firstPage + 3 && metas.length < 20; page += 1) {
    const { items } = await latestAssrt(page);
    if (!items.length) break;

    const works = [];
    const seenWorks = new Set();
    for (const item of items) {
      const parsed = splitAssrtTitle(item.title);
      if (!parsed.title || !usableName(parsed.title) || seenWorks.has(parsed.title)) continue;
      const looksSeries = Boolean(parsed.episode) || /第\s*[零一二三四五六七八九十百千\d]+\s*季|全\s*\d+\s*集/.test(parsed.full);
      if (type === 'series' ? !looksSeries : looksSeries) continue;
      seenWorks.add(parsed.title);
      works.push({ title: parsed.title, year: parsed.year });
      if (works.length >= MAX_LOOKUPS) break;
    }

    const previews = await Promise.all(works.map((work) => previewFor(type, work.title, work.year)));
    for (const preview of previews) {
      if (preview?.meta) push(preview);
      if (metas.length >= 20) break;
    }
  }

  if (metas.length === 0) logSource('catalog', `${source}/${type}/latest 没有能对上 Cinemeta 的条目`);
  return metas;
}

