// Renders the extension icon (blue rounded square, white bookmark ribbon with a sync arc) to PNGs.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function png(size, px) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) px(x, y).forEach((v, i) => (raw[y * (size * 4 + 1) + 1 + x * 4 + i] = v));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function inside(u, v) {
  // u,v in [0,1]
  const r = 0.22, m = 0.02;
  const cx = Math.min(Math.max(u, m + r), 1 - m - r), cy = Math.min(Math.max(v, m + r), 1 - m - r);
  const bg = (u - cx) ** 2 + (v - cy) ** 2 <= r * r && u >= m && u <= 1 - m && v >= m && v <= 1 - m;
  // ribbon: x 0.33..0.67, y 0.2..0.8 with V notch
  const inRibbon = u >= 0.33 && u <= 0.67 && v >= 0.2 && v <= 0.8 && v - 0.8 <= -Math.abs(u - 0.5) * 0.0 && !(v > 0.62 && v - 0.62 > (0.17 - Math.abs(u - 0.5)) * 1.06);
  return { bg, ribbon: inRibbon };
}
mkdirSync('static/icons', { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const S = 4; // supersampling
  const buf = png(size, (x, y) => {
    let bg = 0, rb = 0;
    for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) {
      const r = inside((x + (i + 0.5) / S) / size, (y + (j + 0.5) / S) / size);
      if (r.bg) bg++;
      if (r.bg && r.ribbon) rb++;
    }
    const a = bg / (S * S), w = rb / Math.max(1, bg);
    const blue = [37, 99, 235];
    const col = blue.map((c) => Math.round(c * (1 - w) + 255 * w));
    return [...col, Math.round(255 * a)];
  });
  writeFileSync(`static/icons/icon${size}.png`, buf);
}
console.log('icons written');
