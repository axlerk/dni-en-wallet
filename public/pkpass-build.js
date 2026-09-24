/* Armado del .pkpass: zip, manifest y hashes. Puro, sin dependencias, corre igual en el navegador y en Node.
 *
 * Vive en public/ a propósito. Con esto el teléfono arma el pase entero por su cuenta y le pide al servidor
 * una sola cosa: la firma del manifest, que son hashes. La foto del documento nunca sale del teléfono, sin
 * excepciones: no hay camino de respaldo que la suba.
 */

const te = new TextEncoder();
export const utf8 = (s) => te.encode(s);

export function concat(parts) {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function fromBase64(b64) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
export const sha1hex = async (u8) => hex(new Uint8Array(await crypto.subtle.digest('SHA-1', u8)));
export const sha256hex = async (s) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(s))));

// ---------- Zip (store, sin compresión) ----------
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(u8) { let c = -1; for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
const u16 = (n) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
const u32 = (n) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

export function zipStore(files, date = new Date()) {
  const dosTime = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  const locals = [], centrals = []; let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const n = utf8(name), crc = crc32(data);
    const common = concat([u16(20), u16(0x0800), u16(0), u16(dosTime), u16(dosDate), u32(crc), u32(data.length), u32(data.length), u16(n.length)]);
    const local = concat([u32(0x04034b50), common, u16(0), n, data]);
    centrals.push(concat([u32(0x02014b50), u16(20), common, u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), n]));
    locals.push(local); offset += local.length;
  }
  const cd = concat(centrals);
  const eocd = concat([u32(0x06054b50), u16(0), u16(0), u16(centrals.length), u16(centrals.length), u32(cd.length), u32(offset), u16(0)]);
  return concat([...locals, cd, eocd]);
}

/** Serial estable por documento: regenerar reemplaza el pase en Wallet en vez de duplicarlo. */
export const passSerial = async (dni, ejemplar, passTypeId) =>
  'dni-' + (await sha256hex(`${dni}|${ejemplar}|${passTypeId}`)).slice(0, 24);

/** Los nombres de archivo que puede tener un manifest nuestro: el servidor no firma cualquier cosa. */
export const PASS_FILES = [
  'icon.png', 'icon@2x.png', 'icon@3x.png', 'logo.png', 'logo@2x.png', 'logo@3x.png',
  'strip.png', 'strip@2x.png', 'strip@3x.png', 'pass.json',
];
