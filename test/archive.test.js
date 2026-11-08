import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';

import {
  detectContainer,
  extractArchive,
  extractZip,
  formatBytes,
  isArchiveFile,
  listZipEntries,
  oversizeReason,
  readZipArchives,
  readZipEntry,
} from '../src/archive.js';

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.content, 'utf8');
    const compressed = deflateRawSync(data);
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralBuffer = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, centralBuffer, end]);
}

const SUBTITLE = '1\n00:00:01,000 --> 00:00:02,000\n你好\n';

test('detectContainer sniffs magic bytes', () => {
  assert.equal(detectContainer(buildZip([{ name: 'a.srt', content: SUBTITLE }])), 'zip');
  assert.equal(detectContainer(buildZip([{ name: 'a.srt', content: SUBTITLE }]), 'x.rar'), 'zip');
  assert.equal(detectContainer(Buffer.from('Rar!\u001a\u0007\u0000rest'), 'x.bin'), 'rar');
  assert.equal(detectContainer(Buffer.from('377abcaf271c00', 'hex'), 'x.bin'), '7z');
  assert.equal(detectContainer(Buffer.from(SUBTITLE), 'a.srt'), 'text');
});

test('zip reader lists and extracts subtitle entries', () => {
  const zip = buildZip([
    { name: 'movie.srt', content: SUBTITLE },
    { name: 'notes.md', content: 'not a subtitle' },
  ]);

  const entries = listZipEntries(zip);
  assert.deepEqual(entries.map((entry) => entry.name), ['movie.srt', 'notes.md']);

  const data = readZipEntry(zip, entries[0]).toString('utf8');
  assert.equal(data, SUBTITLE);

  const files = extractZip(zip);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, 'movie.srt');
  assert.equal(files[0].data.toString('utf8'), SUBTITLE);
});

test('extractArchive routes zips through the builtin reader', async () => {
  const zip = buildZip([{ name: 'episode.ass', content: '[Script Info]\n' }]);
  const result = await extractArchive(zip, { container: 'zip' });

  assert.equal(result.tool, 'builtin-zip');
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].name, 'episode.ass');
  assert.deepEqual(result.skipped, []);
});

test('extractArchive says so when the pack simply has no subtitle inside', async () => {
  const zip = buildZip([{ name: 'notes.md', content: 'not a subtitle' }]);
  const result = await extractArchive(zip, { container: 'zip' });

  assert.deepEqual(result.files, []);
  assert.match(result.reason, /未找到字幕文件/);
});

// 90MB 的 SUP 撞上限时，早先只会说一句「压缩包解压后体积过大」或者干脆当作包里没有字幕，
// 用户看到的是「这一条不是图形字幕」。大文件必须点名：是哪个文件、多大。
test('too-big entries are named instead of looking missing', () => {
  const zip = buildZip([{ name: 'movie.sup', content: 'x'.repeat(4096) }]);

  assert.throws(() => extractZip(zip, { maxBytes: 1024 }), /movie\.sup 就有 4KB，上限 1KB/);
  assert.equal(
    oversizeReason([{ name: 'movie.sup', size: 94 * 1024 * 1024 }], 256 * 1024 * 1024),
    '包里的 movie.sup（94.0MB）超过体积上限 256.0MB',
  );
  assert.equal(oversizeReason([], 1024), null);
  assert.equal(oversizeReason(undefined, 1024), null);
  assert.equal(formatBytes(311), '1KB');
});

test('zip reader keeps the image subtitle inside a pack', () => {
  const zip = buildZip([
    { name: 'movie.sup', content: 'PGS' },
    { name: 'movie.zh.srt', content: SUBTITLE },
  ]);

  assert.deepEqual(extractZip(zip).map((file) => file.name).sort(), ['movie.sup', 'movie.zh.srt']);
});

// 站上有「包里套包」：zip 里孤零零装着一个 `xxx.7z`，字幕（常常是 .sup）在里层。
test('readZipArchives digs the inner pack out of a zip', () => {
  const zip = buildZip([
    { name: 'Interstellar-TW-subtitle.7z', content: Buffer.from('377abcaf271c', 'hex') },
    { name: '使用说明.txt', content: 'not a subtitle' },
  ]);

  const archives = readZipArchives(zip);
  assert.deepEqual(archives.map((entry) => entry.name), ['Interstellar-TW-subtitle.7z']);
  assert.equal(archives[0].data.subarray(0, 3).toString('hex'), '377abc');
  assert.equal(isArchiveFile('x.7z'), true);
  assert.equal(isArchiveFile('x.rar'), true);
  assert.equal(isArchiveFile('x.srt'), false);
});

test('extractArchive opens the pack inside the pack', async () => {
  const inner = buildZip([{ name: 'episode.zh.srt', content: SUBTITLE }]);
  const outer = buildZip([{ name: 'episode-pack.zip', content: inner }]);

  const result = await extractArchive(outer, { container: 'zip' });
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].name, 'episode.zh.srt');
  assert.equal(result.tool, 'builtin-zip');
});
