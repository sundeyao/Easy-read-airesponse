import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { zipSync } from 'fflate';
const root = fileURLToPath(new URL('../', import.meta.url));
const extension = join(root, 'extension');
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const output = join(root, 'releases');
await mkdir(output, { recursive: true });
// A small code-generated folded page icon; no external assets or runtime fetches.
function crc32(data) { let n = 0xffffffff; for (const b of data) { n ^= b; for (let k = 0; k < 8; k++) n = (n >>> 1) ^ (0xedb88320 & -(n & 1)); } return (n ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const name = Buffer.from(type); const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length); name.copy(out, 4); data.copy(out, 8); out.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length); return out; }
const pixels = Buffer.alloc((128 * 4 + 1) * 128);
for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
  let c = [51, 91, 71, 255];
  if (x >= 32 && x < 96 && y >= 23 && y < 106 && (x < 72 || y >= 47 || x - 72 < y - 23)) c = [239, 245, 228, 255];
  if (x >= 72 && x < 96 && y >= 23 && y < 47 && x - 72 < y - 23) c = [172, 194, 145, 255];
  if (x >= 44 && x < 81 && [61, 75, 89].some(line => y >= line && y < line + 3)) c = [126, 155, 102, 255];
  const at = y * (128 * 4 + 1) + 1 + x * 4; pixels.set(c, at);
}
const header = Buffer.alloc(13); header.writeUInt32BE(128); header.writeUInt32BE(128, 4); header[8] = 8; header[9] = 6;
await writeFile(join(extension, 'icon.png'), Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]));
const files = {};
async function collect(dir, prefix) { for (const entry of await readdir(dir, { withFileTypes: true })) { if (entry.isDirectory()) await collect(join(dir, entry.name), prefix + entry.name + '/'); else files[prefix + entry.name] = new Uint8Array(await readFile(join(dir, entry.name))); } }
await collect(extension, 'Easy-read-airesponse/');
files['README.txt'] = new Uint8Array(await readFile(join(root, 'README.md')));
const archive = join(output, `Easy-read-airesponse-v${metadata.version}.zip`); await writeFile(archive, zipSync(files));
console.log('Built: ' + extension + '\nPackaged: ' + archive + '\nFiles: ' + Object.keys(files).length);
