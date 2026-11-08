// 行标题（label）的公共小工具：SubHD / 迅雷 / 射手（伪）三个来源都用同一套排版规则，
// 免得同一个客户端里三份字幕长得三种样子（见 addon.js 的 subtitleLabel）。

// 行标题有整行的宽度，但「中文名 + 英文名」这种动不动就超长：留开头和结尾、中间省略。
export function clipMiddle(text, max = 80) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.max(1, max - 1 - head);
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7a3]/;
const LATIN_RE = /[a-z]/i;

// 作品名常常写成「越狱 第一季 Prison Break」：选字幕时后面那截英文一点用都没有，从第一
// 个拉丁字母处截断，只留中文（数字和年份留着）。整个名字都是英文时返回空串让调用方兜底。
export function chineseTitle(text) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!CJK_RE.test(value)) return '';
  const cut = value.search(LATIN_RE);
  const head = (cut < 0 ? value : value.slice(0, cut)).replace(/[\s.·、,，:：;；\-—_|/\\]+$/, '').trim();
  return CJK_RE.test(head) ? head : '';
}

// 「作品名」+ 已有前缀时别在行首重复一遍（只有在后面紧跟分隔符时才算重复）。
export function dropSharedPrefix(text, prefix) {
  const value = String(text ?? '');
  const head = String(prefix ?? '');
  if (!head || !value.startsWith(head)) return value;
  const rest = value.slice(head.length);
  if (!/^[\s.·、,，:：;；\-—_|丨]/.test(rest)) return value;
  return rest.replace(/^[\s.·、,，:：;；\-—_|丨]+/, '');
}

// 「第4集」：名字里已写第几季时就只挂集号，否则用 S01E04。
export function episodeSuffix(name, { season, episode }) {
  if (!episode) return '';
  if (season && !/第\s*[零一二三四五六七八九十百千\d]+\s*季/.test(name)) {
    return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
  }
  return `第${episode}集`;
}
