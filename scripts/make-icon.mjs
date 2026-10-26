// Generates media/icon.png (128x128) without any native dependency: a rounded blue tile with a
// small class hierarchy glyph. Run with `npm run icon`.
import { deflateSync } from "node:zlib"
import { writeFileSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const SIZE = 128
const px = new Uint8Array(SIZE * SIZE * 4)

function blend(x, y, [r, g, b], a) {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE || a <= 0) return
    const i = (y * SIZE + x) * 4
    const ia = px[i + 3] / 255
    const oa = a + ia * (1 - a)
    if (oa === 0) return
    px[i] = Math.round((r * a + px[i] * ia * (1 - a)) / oa)
    px[i + 1] = Math.round((g * a + px[i + 1] * ia * (1 - a)) / oa)
    px[i + 2] = Math.round((b * a + px[i + 2] * ia * (1 - a)) / oa)
    px[i + 3] = Math.round(oa * 255)
}

/** Anti-aliased rounded rectangle via 4x4 super-sampling. */
function roundedRect(x0, y0, w, h, radius, color) {
    const inside = (x, y) => {
        const cx = Math.max(x0 + radius, Math.min(x, x0 + w - radius))
        const cy = Math.max(y0 + radius, Math.min(y, y0 + h - radius))
        return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius
    }
    for (let y = Math.floor(y0); y < Math.ceil(y0 + h); y++) {
        for (let x = Math.floor(x0); x < Math.ceil(x0 + w); x++) {
            let hits = 0
            for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) if (inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) hits++
            blend(x, y, color, hits / 16)
        }
    }
}

function line(x1, y1, x2, y2, width, color) {
    const minX = Math.floor(Math.min(x1, x2) - width), maxX = Math.ceil(Math.max(x1, x2) + width)
    const minY = Math.floor(Math.min(y1, y2) - width), maxY = Math.ceil(Math.max(y1, y2) + width)
    const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy
    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            let hits = 0
            for (let sy = 0; sy < 4; sy++) {
                for (let sx = 0; sx < 4; sx++) {
                    const sxp = x + (sx + 0.5) / 4, syp = y + (sy + 0.5) / 4
                    const t = Math.max(0, Math.min(1, ((sxp - x1) * dx + (syp - y1) * dy) / len2))
                    const d = Math.hypot(sxp - (x1 + t * dx), syp - (y1 + t * dy))
                    if (d <= width / 2) hits++
                }
            }
            blend(x, y, color, hits / 16)
        }
    }
}

const BG = [38, 86, 150]
const BG2 = [30, 66, 118]
const WHITE = [255, 255, 255]
const ACCENT = [255, 196, 64]

roundedRect(0, 0, SIZE, SIZE, 26, BG)
roundedRect(6, 6, SIZE - 12, SIZE - 12, 22, BG2)
// class boxes
const box = (x, y) => {
    roundedRect(x, y, 34, 26, 4, WHITE)
    roundedRect(x, y, 34, 8, 4, ACCENT)
    roundedRect(x, y + 4, 34, 4, 0, ACCENT)
    line(x + 6, y + 15, x + 22, y + 15, 2, BG2)
    line(x + 6, y + 20, x + 28, y + 20, 2, BG2)
}
// hierarchy lines
line(64, 44, 64, 56, 3, WHITE)
line(34, 56, 94, 56, 3, WHITE)
line(34, 56, 34, 70, 3, WHITE)
line(94, 56, 94, 70, 3, WHITE)
box(47, 20)
box(17, 70)
box(77, 70)

// --- PNG encoding -------------------------------------------------------------------------------
const crcTable = new Int32Array(256)
for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c
}
function crc32(buf) {
    let c = -1
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ -1) >>> 0
}
function chunk(type, data) {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, "ascii"), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE)
for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0 // filter: none
    Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1)
}
const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
])
const out = resolve(dirname(fileURLToPath(import.meta.url)), "..", "media", "icon.png")
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, png)
console.log(`wrote ${out} (${png.length} bytes)`)
