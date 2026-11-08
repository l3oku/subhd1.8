import { constants } from 'node:fs';
import { readdirSync } from 'node:fs';
import { access, chmod, copyFile, mkdir, readdir, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const SEVEN_ZIP_NAMES = new Set(['7z', '7zz', '7za']);

// bin/7zzs is the official, statically linked 7-Zip build. It ships with the
// project so RAR/7z subtitles keep working on hosts that have no archive tools
// of their own (Vercel), while the tar/unzip fallbacks below still apply.
const VENDORED_7ZIP = [join(here, '..', 'bin', '7zzs'), join(here, '..', 'bin', '7zz')];

// bsdtar（libarchive）用来解 RAR：7-Zip 的普通发行版都不带 RAR 代码，Alpine 的 libarchive
// 用内置的 RAR reader，能解开大多数 RAR（包括 RAR5 的存/普通压缩）。Linux x64 的这份是
// 从 Alpine 的 libarchive-tools + libarchive 包装里取出来的，库文件放在同一个目录，
// 启动脚本用 LD_LIBRARY_PATH 指过去，不改系统库（函数运行时的 /tmp 是可写的）。
const VENDORED_BSDTAR = [join(here, '..', 'bin', 'linux-x64', 'bsdtar')];
// 带着同名 .so 的可执行文件（bsdtar）一律复制到 /tmp 再跑：部署目录是只读的，
// 而且同目录的 .so 也不一定被 loader 找得到
const RELOCATE_ALWAYS = new Set(['bsdtar']);

const resolved = new Map();

// 「系统 PATH 里有没有这个命令」：直接试跑一下 --version / -h，省得自己拆 PATH
function which(name) {
  return new Promise((resolve) => {
    const child = spawn(name, ['--version'], { stdio: 'ignore' });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      resolve(null);
    }, 3000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(name);
    });
  });
}

async function isExecutable(file) {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Vercel mounts the deployment read-only, so an executable shipped in the repo
// is neither guaranteed the +x bit nor runnable in place: stage it in /tmp.
// force=true 时一律复制一份（bsdtar 还要连同 .so 一起摆好，见 toolEnv）。
async function makeRunnable(file, force = false) {
  if (!force && (await isExecutable(file))) return file;

  const target = join(tmpdir(), 'subhd-bin', basename(file));
  const staged = `${target}.${process.pid}.tmp`;
  try {
    await mkdir(dirname(target), { recursive: true });
    await copyFile(file, staged);
    await chmod(staged, 0o755);
    await rename(staged, target);
  } catch {
    return null;
  }
  return (await isExecutable(target)) ? target : null;
}

// 仓库里带的可执行文件如果依赖同目录的 .so（bsdtar → libarchive.so.13），得把那一份也
// 摆到 /tmp 里，再用 LD_LIBRARY_PATH 指过去。找不到「目录里有 .so」的迹象就当独立的静态文件。
async function ensureLibraries(sourceDir) {
  try {
    const entries = await readdir(sourceDir);
    const libraries = entries.filter((entry) => /\.so(\.\d+)*$/.test(entry));
    if (libraries.length === 0) return null;
    let targetDir = null;
    for (const library of libraries) {
      const staged = join(tmpdir(), 'subhd-bin', library);
      const ready = await makeRunnable(join(sourceDir, library), true);
      if (ready) targetDir = dirname(staged);
    }
    return targetDir;
  } catch {
    return null;
  }
}

// 仓库里的 bin/ 下面按平台分目录（bin/zzzs、bin/linux-x64/bsdtar）；可执行文件跑到 /tmp
// 之后，要靠这个找到「它原来在哪个目录、旁边有哪些 .so」
function repoDirOf(toolName) {
  const candidates = [join(here, '..', 'bin', 'linux-x64'), join(here, '..', 'bin')];
  return candidates.find((dir) => {
    try {
      return readdirSync(dir).includes(toolName);
    } catch {
      return false;
    }
  }) || null;
}

export async function toolEnv(tool) {
  if (!tool || !/subhd-bin[\\/]/.test(tool)) return {};
  const dir = dirname(tool);
  // .so 在仓库里的那个目录（/tmp 里只摆了可执行文件），摆到同一个 /tmp 目录再指过去
  const sourceDir = repoDirOf(basename(tool));
  const libDir = sourceDir ? await ensureLibraries(sourceDir) : null;
  const parts = [libDir, dir, process.env.LD_LIBRARY_PATH].filter(Boolean);
  const libraryPath = [...new Set(parts)].join(':');
  return libDir ? { LD_LIBRARY_PATH: libraryPath } : {};
}

async function findTool(name) {
  const linuxX64 = process.platform === 'linux' && process.arch === 'x64';
  if (linuxX64 && SEVEN_ZIP_NAMES.has(name)) {
    const candidates = process.env.SEVEN_ZIP_PATH ? [process.env.SEVEN_ZIP_PATH] : VENDORED_7ZIP;
    for (const candidate of candidates) {
      const runnable = await makeRunnable(candidate);
      if (runnable) return runnable;
    }
  }
  // bsdtar：仓库里带了 Linux x64 的一份就用它（函数运行时里没有），否则用系统里的
  // 系统里有 bsdtar（Docker 镜像里装了 libarchive-tools）就直接用，省得摆库文件
  if (name === 'bsdtar') {
    const system = await which(name);
    if (system) return system;
    if (linuxX64) {
      for (const candidate of VENDORED_BSDTAR) {
        const runnable = await makeRunnable(candidate, RELOCATE_ALWAYS.has(name));
        if (runnable) return runnable;
      }
    }
  }
  return name;
}

export function resolveTool(name) {
  if (!resolved.has(name)) resolved.set(name, findTool(name));
  return resolved.get(name);
}
