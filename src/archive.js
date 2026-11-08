import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { resolveTool, toolEnv } from './binary.js';

const SIG_LOCAL_FILE = 0x04034b50;
const SIG_CENTRAL_DIR = 0x02014b50;
const SIG_END_OF_CENTRAL_DIR = 0x06054b50;

// `.sup` / `.pgs` 是图形字幕（一张张图片），不解码成文本，但同样要从压缩包里挑出来，
// 见 pickImageSubtitleFile / getSubtitleBinary。
export const SUBTITLE_EXTENSIONS = ['.srt', '.ass', '.ssa', '.vtt', '.sub', '.smi', '.txt', '.sup', '.pgs'];

// 站上「包里套包」不少见：一个 zip 里躺着一个 `xxx.7z`，真正的 .sup 在里层（条目
// 4aBJzO 就是「Interstellar-TW-subtitle.7z」孤零零装在一个 zip 里）。所以只解一层不够，
// 见 extractArchive 的递归。
export const ARCHIVE_EXTENSIONS = ['.zip', '.rar', '.7z'];

export function isArchiveFile(name) {
  return ARCHIVE_EXTENSIONS.includes(extname(String(name)).toLowerCase());
}

export function detectContainer(buffer, hintName = '') {
  if (buffer.length >= 6) {
    if (buffer.subarray(0, 5).toString('binary') === 'Rar!\u001a' && buffer[5] === 0x07) return 'rar';
    if (buffer.subarray(0, 6).toString('hex') === '377abcaf271c') return '7z';
  }
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === SIG_LOCAL_FILE) return 'zip';

  const ext = extname(hintName).toLowerCase().replace('.', '');
  if (['rar', 'zip', '7z'].includes(ext)) return ext;
  if (['srt', 'ass', 'ssa', 'vtt', 'sub', 'txt', 'smi'].includes(ext)) return 'text';
  return 'unknown';
}

export function isSubtitleFile(name) {
  return SUBTITLE_EXTENSIONS.includes(extname(String(name)).toLowerCase());
}

function findEndOfCentralDirectory(buffer) {
  const limit = Math.max(0, buffer.length - 66_000);
  for (let offset = buffer.length - 22; offset >= limit; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== SIG_END_OF_CENTRAL_DIR) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength <= buffer.length) return offset;
  }
  return -1;
}

export function listZipEntries(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) return [];

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];

  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== SIG_CENTRAL_DIR) break;

    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const entry = {
      name: buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'),
      method: buffer.readUInt16LE(offset + 10),
      compressedSize: buffer.readUInt32LE(offset + 20),
      uncompressedSize: buffer.readUInt32LE(offset + 24),
      localOffset: buffer.readUInt32LE(offset + 42),
    };
    entries.push(entry);
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

export function readZipEntry(buffer, entry) {
  const { localOffset } = entry;
  if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== SIG_LOCAL_FILE) {
    throw new Error(`ZIP 条目损坏: ${entry.name}`);
  }
  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLength + extraLength;
  const raw = buffer.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`不支持的 ZIP 压缩方式 ${entry.method}: ${entry.name}`);
}

export function extractZip(buffer, { maxBytes = 256 * 1024 * 1024 } = {}) {
  const files = [];
  let total = 0;

  for (const entry of listZipEntries(buffer)) {
    if (entry.name.endsWith('/') || entry.compressedSize === 0xffffffff) continue;
    if (!isSubtitleFile(entry.name)) continue;
    const data = readZipEntry(buffer, entry);
    total += data.length;
    if (total > maxBytes) {
      throw new Error(
        `压缩包解压后体积过大（${basename(entry.name)} 就有 ${formatBytes(data.length)}，上限 ${formatBytes(maxBytes)}）`,
      );
    }
    files.push({ name: basename(entry.name), data });
  }

  return files;
}

// zip 里套着的那份压缩包：内置 zip 读不了里层，但能先把里层原样取出来交给上层去解。
export function readZipArchives(buffer, { maxBytes = 256 * 1024 * 1024 } = {}) {
  const archives = [];
  let total = 0;

  for (const entry of listZipEntries(buffer)) {
    if (entry.name.endsWith('/') || entry.compressedSize === 0xffffffff) continue;
    if (!isArchiveFile(entry.name)) continue;
    const data = readZipEntry(buffer, entry);
    if (total + data.length > maxBytes) continue;
    total += data.length;
    archives.push({ name: basename(entry.name), size: data.length, data });
  }

  return archives;
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  const mb = value / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)}MB` : `${Math.max(1, Math.round(value / 1024))}KB`;
}

// 字幕包里常有一份几十上百 MB 的图形字幕（SUP/PGS 是一帧帧图片），撞上体积上限时必须
// 指名道姓：否则上层只看到「包里没有字幕」，用户拿到的是「不是图形字幕，请换一条」这种
// 和实际情况完全对不上的提示。
export function oversizeReason(skipped, maxBytes) {
  if (!Array.isArray(skipped) || skipped.length === 0) return null;
  const biggest = skipped.reduce((a, b) => (b.size > a.size ? b : a));
  return `包里的 ${biggest.name}（${formatBytes(biggest.size)}）超过体积上限 ${formatBytes(maxBytes)}`;
}

const TOOL_CHAINS = {
  zip: [
    ['7z', ['x', '-y', '-bso0', '-bsp0', '-o{DIR}', '{FILE}']],
    ['7zz', ['x', '-y', '-bso0', '-bsp0', '-o{DIR}', '{FILE}']],
    ['7za', ['x', '-y', '-bso0', '-bsp0', '-o{DIR}', '{FILE}']],
    ['unzip', ['-o', '-qq', '{FILE}', '-d', '{DIR}']],
    ['bsdtar', ['-xf', '{FILE}', '-C', '{DIR}']],
    ['tar', ['-xf', '{FILE}', '-C', '{DIR}']],
  ],
  rar: [
    ['7z', ['x', '-y', '-bso0', '-bsp0', '-o{DIR}', '{FILE}']],
    ['7zz', ['x', '-y', '-bso0', '-bsp0', '-o{DIR}', '{FILE}']],
    // 仓库自带的 7zzs 是官方「完整版」7-Zip，能解 RAR；系统里那套（p7zip / Alpine 的 7zip）
    // 因为是版权原因，只打包了 7z/zip 的代码，碰到 .rar 会直接报「Cannot open the file as archive」。
    // libarchive 的 bsdtar 用内置的 RAR reader，正好补上这个窟窿（Dockerfile 里已经装了）。
    ['bsdtar', ['-xf', '{FILE}', '-C', '{DIR}']],
    ['unrar', ['x', '-o+', '-idq', '{FILE}', '{DIR}']],
    ['unar', ['-quiet', '-o', '{DIR}', '{FILE}']],
    ['tar', ['-xf', '{FILE}', '-C', '{DIR}']],
  ],
  '7z': [
    ['7z', ['x', '-y', '-bso0', '-bsp0', '-o{DIR}', '{FILE}']],
    ['7zz', ['x', '-y', '-bso0', '-bsp0', '-o{DIR}', '{FILE}']],
    ['7za', ['x', '-y', '-bso0', '-bsp0', '-o{DIR}', '{FILE}']],
    ['bsdtar', ['-xf', '{FILE}', '-C', '{DIR}']],
    ['tar', ['-xf', '{FILE}', '-C', '{DIR}']],
  ],
};

function run(command, args, timeoutMs = 30_000, env = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child;
    try {
      child = spawn(command, args, { stdio: 'ignore', windowsHide: true, env: { ...process.env, ...env } });
    } catch (error) {
      finish({ ok: false, reason: error.message });
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish({ ok: false, reason: 'timeout' });
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      finish({ ok: false, reason: error.code || error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ ok: code === 0, reason: `exit ${code}` });
    });
  });
}

// 解压目录里的所有文件：字幕要，里层的压缩包也要（包里套包时真正的字幕在里层）。
async function walkFiles(dir, depth = 0) {
  if (depth > 3) return [];
  const found = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await walkFiles(full, depth + 1)));
    } else {
      found.push({ name: entry.name, path: full });
    }
  }
  return found;
}

// 里层的压缩包读进内存，交给 extractArchive 递归解。只认压缩包后缀：包里那些说明 txt、
// 效果图 jpg 不用读。
async function readNestedArchives(files, maxBytes) {
  const archives = [];
  let total = 0;

  for (const file of files) {
    const size = (await stat(file.path)).size;
    if (total + size > maxBytes) continue;
    const data = await readFile(file.path);
    total += data.length;
    archives.push({ name: file.name, size: data.length, data });
  }

  return archives;
}

// 返回值里的 `skipped` 是「包里有、但超过体积上限没读进来」的文件：不报出来，上层只会
// 看到「压缩包里没有字幕」，而实际情况往往是那个 90MB 的 .sup 被上限挡在了外面。
export async function extractWithSystemTool(buffer, container, { maxBytes = 256 * 1024 * 1024 } = {}) {
  const chain = TOOL_CHAINS[container] || [];
  if (chain.length === 0) {
    return { files: [], tool: null, reason: 'no-extractor', skipped: [], archives: [] };
  }

  const workDir = await mkdtemp(join(tmpdir(), 'subhd-extract-'));
  const archivePath = join(workDir, `archive.${container}`);

  try {
    await writeFile(archivePath, buffer);
    const errors = [];

    const tried = new Set();
    let skipped = [];

    for (const [command, template] of chain) {
      const executable = await resolveTool(command);
      // The bundled 7-Zip answers to 7z / 7zz / 7za alike; run it only once.
      if (tried.has(executable)) continue;
      tried.add(executable);
      const outDir = join(workDir, `out-${command}`);
      await mkdir(outDir, { recursive: true });
      const args = template.map((arg) =>
        arg.replace('{FILE}', archivePath).replace('{DIR}', outDir),
      );
      // bsdtar 这类带 .so 的可执行文件要额外给一个 LD_LIBRARY_PATH（见 binary.js）
      const result = await run(executable, args, 30_000, await toolEnv(executable));
      if (!result.ok) {
        errors.push(`${command}: ${result.reason}`);
        continue;
      }

      let found = [];
      try {
        found = await walkFiles(outDir);
      } catch {
        found = [];
      }
      const files = found.filter((file) => isSubtitleFile(file.name));
      const nested = found.filter((file) => isArchiveFile(file.name));
      if (files.length === 0 && nested.length === 0) {
        errors.push(`${command}: 未找到字幕文件`);
        continue;
      }

      const archives = await readNestedArchives(nested, maxBytes);
      if (files.length === 0) {
        // 这一层只有里层压缩包，字幕得进去再解一次
        return { files: [], tool: null, reason: '未找到字幕文件', skipped: [], archives };
      }

      const loaded = [];
      const attemptSkipped = [];
      let total = 0;
      for (const file of files) {
        // 先看大小再读：90MB 的字幕读进来再丢掉，白花时间和内存
        const size = (await stat(file.path)).size;
        if (total + size > maxBytes) {
          attemptSkipped.push({ name: file.name, size });
          continue;
        }
        const data = await readFile(file.path);
        total += data.length;
        loaded.push({ name: file.name, data });
      }
      if (attemptSkipped.length > 0) skipped = attemptSkipped;
      if (loaded.length === 0) {
        errors.push(`${command}: ${oversizeReason(attemptSkipped, maxBytes)}`);
        continue;
      }
      return { files: loaded, tool: command, reason: null, skipped: attemptSkipped, archives };
    }

    return {
      files: [],
      tool: null,
      reason: errors.join(' | ') || 'extract-failed',
      skipped,
      archives: [],
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function extractLevel(buffer, kind, { maxBytes }) {
  if (kind === 'zip') {
    try {
      const files = extractZip(buffer, { maxBytes });
      if (files.length > 0) return { files, tool: 'builtin-zip', reason: null, skipped: [] };
      return {
        files: [],
        tool: null,
        reason: '未找到字幕文件',
        skipped: [],
        archives: readZipArchives(buffer, { maxBytes }),
      };
    } catch (error) {
      // 内置读不了的 ZIP（加密、分卷、解压后太大）交给系统里的 7-Zip 再试一次
      const fallback = await extractWithSystemTool(buffer, 'zip', { maxBytes });
      if (fallback.files.length > 0) return fallback;
      return {
        files: [],
        tool: null,
        reason: fallback.reason ? `${error.message} | ${fallback.reason}` : error.message,
        skipped: fallback.skipped,
        archives: fallback.archives || [],
      };
    }
  }
  if (kind === 'rar' || kind === '7z') {
    return extractWithSystemTool(buffer, kind, { maxBytes });
  }
  return { files: [], tool: null, reason: `未知压缩格式: ${kind}`, skipped: [], archives: [] };
}

// 包里套包最多再往里挖两层：再深的不是真字幕包，是有人把整个网盘备份传上来了。
const MAX_ARCHIVE_DEPTH = 2;

export async function extractArchive(
  buffer,
  { container, maxBytes = 256 * 1024 * 1024, depth = 0 } = {},
) {
  const kind = container || detectContainer(buffer);
  const result = await extractLevel(buffer, kind, { maxBytes });
  const nested = result.archives || [];
  if (nested.length === 0 || depth >= MAX_ARCHIVE_DEPTH) return result;

  // 里层的字幕和这一层的合在一起：图形字幕经常只存在于里层那个 .7z 里
  const files = [...result.files];
  const tools = [result.tool];
  let skipped = [...(result.skipped || [])];

  for (const inner of nested) {
    const deeper = await extractArchive(inner.data, {
      container: detectContainer(inner.data, inner.name),
      maxBytes,
      depth: depth + 1,
    });
    files.push(...deeper.files);
    skipped = skipped.concat(deeper.skipped || []);
    if (deeper.tool) tools.push(deeper.tool);
  }

  if (files.length === 0) return { ...result, skipped };
  return {
    files,
    tool: [...new Set(tools.filter(Boolean))].join(' > ') || null,
    reason: null,
    skipped,
  };
}
