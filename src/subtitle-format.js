import { spawnSync } from 'node:child_process';

export const SUBTITLE_MIME = {
  srt: 'application/x-subrip; charset=utf-8',
  ass: 'text/x-ssa; charset=utf-8',
  ssa: 'text/x-ssa; charset=utf-8',
  vtt: 'text/vtt; charset=utf-8',
  sub: 'text/plain; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  // SUP/PGS 图形字幕：里面是一帧帧图片，原样交给播放器，服务端不做文本解码
  sup: 'application/x-pgs',
};

export const stripBom = (value) => String(value ?? '').replace(/^\uFEFF/, '');

export const hasUtf16Bom = (buffer) =>
  Buffer.isBuffer(buffer) && buffer.length >= 2 &&
  ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff));

export function isProbablyBinary(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const sample = bytes.subarray(0, 4096);
  if (sample.length === 0) return false;

  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
  }
  return control / sample.length > 0.05;
}

// 候选编码。GB18030 几乎不会解出替换字符，所以不能「谁先不报错就用谁」：繁中字幕
// 通常是 Big5，按顺序试会先被 GB18030 解成「荡㏑瑀畍」这种像字其实不是字的怪码。
const DECODER_CANDIDATES = ['utf-8', 'big5', 'gb18030', 'shift_jis'];

// 正常字幕里几乎不会出现的区段：CJK 兼容符号（㏑、㏕）、康熙部首、兼容汉字、私用区……
const RARE_RANGES = [
  [0x0080, 0x009f],
  [0x2e80, 0x2fdf],
  [0x3300, 0x33ff],
  [0x3400, 0x4dbf],
  [0xe000, 0xf8ff],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe6f],
];

const isCommonCodePoint = (code) =>
  code < 0x80 ||
  (code >= 0x4e00 && code <= 0x9fff) ||
  (code >= 0x3000 && code <= 0x303f) ||
  (code >= 0xff01 && code <= 0xff5e) ||
  (code >= 0x3040 && code <= 0x30ff) ||
  (code >= 0xac00 && code <= 0xd7a3) ||
  (code >= 0x3100 && code <= 0x312f);

const isRareCodePoint = (code) =>
  RARE_RANGES.some(([start, end]) => code >= start && code <= end);

// 给解出来的文本打分：常见字符 +1，可疑字符 -1，替换字符 -5，最后取平均。只看前
// 2 万个字符就够了（够长到能拉开差距，又不至于让每个候选都扫完整篇字幕）。
const SCORE_SAMPLE_CHARS = 20_000;

export function scoreDecodedText(text) {
  const source = String(text ?? '');
  if (!source) return -1;

  let score = 0;
  let count = 0;
  for (const char of source) {
    if (count >= SCORE_SAMPLE_CHARS) break;
    count += 1;
    const code = char.codePointAt(0);
    if (code === 0xfffd) score -= 5;
    else if (isCommonCodePoint(code)) score += 1;
    else if (isRareCodePoint(code)) score -= 1;
    else score += 0.2;
  }

  return count === 0 ? -1 : score / count;
}

// 少数运行环境（比如 iSH 里那个不带完整 ICU 的 node）TextDecoder 不认 gb18030 / big5。
// 这种情况才去问系统的 iconv；Vercel / 官方 Node 都带完整 ICU，永远走不到这里。
// 同步 spawnSync：解码是纯计算，调用方到处是同步的（shareNote / noteOnly / 列表），
// 不能为了它把整条链路变成 async。
const ICONV_NAMES = { gb18030: 'GB18030', big5: 'BIG5', shift_jis: 'SHIFT_JIS' };
let iconvChecked = null;

function iconvAvailable() {
  if (iconvChecked === null) {
    // busybox 的 iconv 不认 --version，用一段已知的 GBK 字节试解码
    const probe = spawnSync('iconv', ['-f', 'GB18030', '-t', 'UTF-8'], { input: Buffer.from('c4e3bac3', 'hex'), timeout: 3000 });
    iconvChecked = Boolean(probe.stdout && probe.stdout.toString('utf8') === '你好');
  }
  return iconvChecked;
}

function runIconvSync(bytes, encoding) {
  // 只喂前 4MB：字幕正文极少超过这个量，再长也没必要为了挑编码全解一遍
  const result = spawnSync('iconv', ['-f', ICONV_NAMES[encoding], '-t', 'UTF-8'], {
    input: bytes.subarray(0, 4 * 1024 * 1024),
    timeout: 10_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || !result.stdout || result.stdout.length === 0) return null;
  return Buffer.from(result.stdout).toString('utf8');
}

function decodeCandidate(bytes, encoding) {
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(bytes);
  } catch {
    if (!iconvAvailable()) return null;
    return runIconvSync(bytes, encoding);
  }
}

// 用「解出来最像正常文本」的编码解字幕。纯 UTF-8 / ASCII 文件仍然是 UTF-8（同分时
// 保留前一个候选，而 utf-8 排在最前面）。
export function decodeTextBuffer(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  let best = null;

  for (const encoding of DECODER_CANDIDATES) {
    const text = decodeCandidate(bytes, encoding);
    if (text === null) continue;
    const score = scoreDecodedText(text);
    if (!best || score > best.score) best = { encoding, text, score };
  }

  return best ?? { encoding: 'utf-8', text: bytes.toString('utf8'), score: -1 };
}

export function detectTextFormat(text) {
  const source = stripBom(text);
  const head = source.slice(0, 8192);

  if (/^\s*\[Script Info\]/im.test(head) || /^\s*Dialogue:\s/im.test(source.slice(0, 200_000))) {
    return /^ScriptType:\s*v4\.00\+/im.test(head) ? 'ass' : 'ssa';
  }
  if (/^\s*WEBVTT/.test(head)) return 'vtt';
  if (/^\s*(?:\d+\s*\r?\n)?\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(head)) return 'srt';
  if (/^\s*\{\d+\}\{\d+\}/m.test(head)) return 'sub';
  return 'unknown';
}

const pad = (value, size = 2) => String(value).padStart(size, '0');

function centisecondsToMs(value) {
  const match = String(value).trim().match(/^(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
  if (!match) return null;
  const [, hours, minutes, seconds, fraction] = match;
  const millis = fraction.length === 1 ? Number(fraction) * 100 : fraction.length === 2 ? Number(fraction) * 10 : Number(fraction);
  return (
    Number(hours) * 3_600_000 + Number(minutes) * 60_000 + Number(seconds) * 1000 + millis
  );
}

function formatSrtTime(ms) {
  const total = Math.max(0, Math.round(ms));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
}

function formatAssTime(ms) {
  const total = Math.max(0, Math.round(ms));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const centis = Math.floor((total % 1000) / 10);
  return `${hours}:${pad(minutes)}:${pad(seconds)}.${pad(centis)}`;
}

const stripAssTags = (text) =>
  String(text ?? '')
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\[Nn]/g, '\n')
    .replace(/\\h/g, ' ')
    .trim();

export function assToSrt(text) {
  const source = stripBom(text).replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  let inEvents = false;
  let fields = null;
  const cues = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[.*\]$/.test(trimmed)) {
      inEvents = /^\[events\]$/i.test(trimmed);
      continue;
    }
    if (!inEvents) continue;

    if (/^format\s*:/i.test(trimmed)) {
      fields = trimmed
        .slice(trimmed.indexOf(':') + 1)
        .split(',')
        .map((field) => field.trim().toLowerCase());
      continue;
    }

    if (!/^dialogue\s*:/i.test(trimmed)) continue;
    const payload = trimmed.slice(trimmed.indexOf(':') + 1).trim();
    const order = fields || ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
    const textIndex = order.indexOf('text');
    const parts = payload.split(',');
    const head = parts.slice(0, textIndex < 0 ? 9 : textIndex);
    const body = parts.slice(textIndex < 0 ? 9 : textIndex).join(',');

    const startIndex = order.indexOf('start');
    const endIndex = order.indexOf('end');
    const start = centisecondsToMs(head[startIndex]);
    const end = centisecondsToMs(head[endIndex]);
    if (start === null || end === null) continue;

    const content = stripAssTags(body);
    if (!content) continue;
    cues.push({ start, end: Math.max(end, start + 200), content });
  }

  cues.sort((a, b) => a.start - b.start);

  const blocks = cues.map((cue, index) => {
    const body = cue.content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n');
    return `${index + 1}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}\n${body}`;
  });

  return `${blocks.join('\n\n')}\n`;
}

export function parseSrt(text) {
  const source = stripBom(text).replace(/\r\n?/g, '\n');
  const cues = [];
  const blocks = source.split(/\n{2,}/);

  for (const block of blocks) {
    const lines = block.split('\n').filter((line, index) => !(index === 0 && line.trim() === ''));
    if (lines.length === 0) continue;
    let cursor = 0;
    if (/^\d+$/.test(lines[0].trim())) cursor = 1;
    const timing = (lines[cursor] || '').match(/(\d{1,3}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,3}:\d{2}:\d{2}[,.]\d{1,3})/);
    if (!timing) continue;
    const start = centisecondsToMs(timing[1].replace(',', '.'));
    const end = centisecondsToMs(timing[2].replace(',', '.'));
    if (start === null || end === null) continue;
    const content = lines.slice(cursor + 1).join('\n').trim();
    if (!content) continue;
    cues.push({ start, end, content });
  }

  return cues;
}

const ASS_HEADER = `[Script Info]
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,58,&H00FFFFFF,&H000000FF,&H00202020,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,24,24,32,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

export function srtToAss(text) {
  const cues = parseSrt(text);
  const events = cues.map((cue) => {
    const body = cue.content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\\N');
    return `Dialogue: 0,${formatAssTime(cue.start)},${formatAssTime(cue.end)},Default,,0,0,0,,${body}`;
  });
  return `${ASS_HEADER}\n${events.join('\n')}\n`;
}

export function convertSubtitle(text, from, to) {
  const source = stripBom(text);
  const detected = from === 'unknown' ? detectTextFormat(source) : from;
  const target = to === 'ssa' ? 'ass' : to;
  if (detected === target) return source;
  if ((detected === 'ass' || detected === 'ssa') && target === 'srt') return assToSrt(source);
  if (detected === 'srt' && target === 'ass') return srtToAss(source);
  if (detected === 'vtt' && target === 'srt') {
    return source
      .replace(/^\s*WEBVTT.*$/im, '')
      .replace(/(\d{1,2}:\d{2}:\d{2})\.(\d{1,3})/g, '$1,$2')
      .replace(/<[^>]+>/g, '')
      .trim()
      .concat('\n');
  }
  return source;
}
