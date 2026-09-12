/* Armado y firma de .pkpass sin dependencias, sobre WebCrypto — corre igual en Node (≥19) y en Cloudflare Workers.
 *
 * Un .pkpass es un zip (sin compresión) con pass.json, imágenes, manifest.json (sha1 hex de cada archivo) y
 * signature: PKCS#7/CMS SignedData "detached" sobre manifest.json, firmado con el certificado del Pass Type ID
 * e incluyendo el certificado WWDR de Apple. La estructura replica la que produce passkit-generator (node-forge):
 * digest SHA-1, atributos firmados contentType + messageDigest + signingTime, RSASSA-PKCS1-v1_5.
 *
 * Por qué a mano: en Workers el plan gratuito da 10 ms de CPU por request; RSA en JS puro (forge) no entra,
 * crypto.subtle es nativo. Y el mismo módulo sirve para el servidor Node local.
 */

// ---------- Utilidades de bytes ----------
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

const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const sha1 = async (u8) => new Uint8Array(await crypto.subtle.digest('SHA-1', u8));
export const sha256hex = async (s) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(s))));

/** PEM → DER (primer bloque). Devuelve también el label (CERTIFICATE / PRIVATE KEY / RSA PRIVATE KEY). */
export function pemToDer(pem) {
  const m = /-----BEGIN ([^-]+)-----([\s\S]*?)-----END \1-----/.exec(String(pem));
  if (!m) throw new Error('PEM inválido');
  return { label: m[1].trim(), der: fromBase64(m[2].replace(/\s+/g, '')) };
}

// ---------- DER mínimo ----------
function derLen(n) {
  if (n < 0x80) return new Uint8Array([n]);
  const bytes = []; for (let v = n; v > 0; v >>>= 8) bytes.unshift(v & 0xff);
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, ...parts) => { const body = concat(parts); return concat([new Uint8Array([tag]), derLen(body.length), body]); };
const SEQ = (...p) => tlv(0x30, ...p);
const SET = (...p) => tlv(0x31, ...p);
const CTX = (n, ...p) => tlv(0xa0 | n, ...p); // [n] constructed
const INT = (n) => tlv(0x02, new Uint8Array([n]));
const NULL = () => new Uint8Array([0x05, 0x00]);
const OCTET = (u8) => tlv(0x04, u8);
function OID(str) {
  const a = str.split('.').map(Number);
  const out = [40 * a[0] + a[1]];
  for (const v of a.slice(2)) { const s = []; let x = v; do { s.unshift(x & 0x7f); x >>>= 7; } while (x > 0); for (let i = 0; i < s.length - 1; i++) s[i] |= 0x80; out.push(...s); }
  return tlv(0x06, new Uint8Array(out));
}
function UTCTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return tlv(0x17, utf8(`${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`));
}
const algId = (oid) => SEQ(OID(oid), NULL());
const cmpBytes = (a, b) => { const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; };

const OIDS = {
  data: '1.2.840.113549.1.7.1', signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3', messageDigest: '1.2.840.113549.1.9.4', signingTime: '1.2.840.113549.1.9.5',
  sha1: '1.3.14.3.2.26', rsaEncryption: '1.2.840.113549.1.1.1',
};

/** Lector TLV: {tag, hdr (inicio del contenido), len, end, raw (TLV completo)}. */
function readTlv(buf, off) {
  const tag = buf[off]; let len = buf[off + 1]; let p = off + 2;
  if (len & 0x80) { const n = len & 0x7f; len = 0; for (let i = 0; i < n; i++) len = (len << 8) | buf[p++]; }
  return { tag, hdr: p, len, end: p + len, raw: buf.subarray(off, p + len) };
}

/** De un certificado X.509 DER saca issuer (Name, TLV completo) y serialNumber (INTEGER, TLV completo). */
function certIssuerAndSerial(der) {
  const cert = readTlv(der, 0);
  const tbs = readTlv(der, cert.hdr);
  let p = tbs.hdr;
  let t = readTlv(der, p);
  if (t.tag === 0xa0) { p = t.end; t = readTlv(der, p); } // version [0] opcional
  const serial = t; p = t.end;                              // serialNumber
  p = readTlv(der, p).end;                                  // signature AlgorithmIdentifier
  const issuer = readTlv(der, p);                           // issuer Name
  return { issuer: issuer.raw, serial: serial.raw };
}

/** PKCS#1 "RSA PRIVATE KEY" → PKCS#8 (lo que acepta crypto.subtle). */
const pkcs1ToPkcs8 = (pkcs1) => SEQ(INT(0), algId(OIDS.rsaEncryption), OCTET(pkcs1));

// ---------- Firma PKCS#7 ----------
export async function signManifest(manifestBytes, { wwdrPem, signerCertPem, signerKeyPem }, now = new Date()) {
  const wwdr = pemToDer(wwdrPem).der;
  const signer = pemToDer(signerCertPem).der;
  const key = pemToDer(signerKeyPem);
  if (/ENCRYPTED/.test(key.label)) throw new Error('La clave está cifrada: exportar sin passphrase (openssl pkcs8 -topk8 -nocrypt)');
  const pkcs8 = key.label === 'RSA PRIVATE KEY' ? pkcs1ToPkcs8(key.der) : key.der;
  const cryptoKey = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-1' }, false, ['sign']);

  const attrs = [
    SEQ(OID(OIDS.contentType), SET(OID(OIDS.data))),
    SEQ(OID(OIDS.messageDigest), SET(OCTET(await sha1(manifestBytes)))),
    SEQ(OID(OIDS.signingTime), SET(UTCTime(now))),
  ].sort(cmpBytes); // DER: SET OF ordenado
  // Lo que se firma es el SET de atributos (tag 0x31); en la estructura va como [0] IMPLICIT (0xA0).
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, cryptoKey, SET(...attrs)));
  const { issuer, serial } = certIssuerAndSerial(signer);

  const signerInfo = SEQ(
    INT(1),
    SEQ(issuer, serial),
    algId(OIDS.sha1),
    CTX(0, ...attrs),
    algId(OIDS.rsaEncryption),
    OCTET(signature),
  );
  const signedData = SEQ(
    INT(1),
    SET(algId(OIDS.sha1)),
    SEQ(OID(OIDS.data)),   // encapContentInfo sin eContent → detached
    CTX(0, wwdr, signer),
    SET(signerInfo),
  );
  return SEQ(OID(OIDS.signedData), CTX(0, signedData));
}

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

// ---------- Contenido del pase ----------
// Vive en public/ para que la PWA arme la misma vista previa con el mismo pass.json (una sola fuente de verdad).
import { clean, buildPassJson } from '../public/pass-json.js';

export function dataUrlToPng(s) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(s || ''));
  if (!m) throw Object.assign(new Error('strip inválido (se espera data:image/png;base64)'), { status: 400 });
  return fromBase64(m[1]);
}

/** Body application/x-www-form-urlencoded → {fields, strips}. */
export function parsePassForm(body) {
  const p = new URLSearchParams(body);
  let fields;
  try { fields = JSON.parse(p.get('fields') || '{}'); } catch { throw Object.assign(new Error('fields no es JSON'), { status: 400 }); }
  return { fields, strips: { strip1x: p.get('strip1x'), strip2x: p.get('strip2x'), strip3x: p.get('strip3x') } };
}

/**
 * Arma y firma el pase. cfg: {passTypeId, teamId, orgName}; certs: {wwdrPem, signerCertPem, signerKeyPem} (strings PEM);
 * assets: {nombre: Uint8Array} con icon/logo. Devuelve {bytes, serial}.
 */
export async function createPkpass({ cfg, certs, assets, fields, strips }) {
  if (!certs) throw Object.assign(new Error('Faltan certificados'), { status: 503 });
  if (!clean(fields.apellido) || !clean(fields.nombres) || !clean(fields.dni)) throw Object.assign(new Error('apellido, nombres y dni son obligatorios'), { status: 400 });

  // Serial estable por documento: regenerar reemplaza el pase en Wallet en vez de duplicarlo. No se guarda en ningún lado.
  const serial = 'dni-' + (await sha256hex(`${clean(fields.dni)}|${clean(fields.ejemplar)}|${cfg.passTypeId}`)).slice(0, 24);

  const files = {
    ...assets,
    'strip.png': dataUrlToPng(strips.strip1x),
    'strip@2x.png': dataUrlToPng(strips.strip2x),
    'strip@3x.png': dataUrlToPng(strips.strip3x),
    'pass.json': utf8(JSON.stringify(buildPassJson(cfg, fields, serial))),
  };
  const manifest = {};
  for (const [name, data] of Object.entries(files)) manifest[name] = hex(await sha1(data));
  const manifestBytes = utf8(JSON.stringify(manifest));
  files['manifest.json'] = manifestBytes;
  files['signature'] = await signManifest(manifestBytes, certs);
  return { bytes: zipStore(files), serial };
}
