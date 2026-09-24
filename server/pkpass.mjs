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

// Lo que también necesita el navegador (zip, manifest, hashes) vive en public/pkpass-build.js.
export { utf8, concat, fromBase64, sha256hex, passSerial } from '../public/pkpass-build.js';
import { utf8, concat, fromBase64, passSerial, sha1hex } from '../public/pkpass-build.js';

const sha1 = async (u8) => new Uint8Array(await crypto.subtle.digest('SHA-1', u8));

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

/**
 * Firma el pase que armó el teléfono, SIN recibir la foto.
 *
 * Clave de seguridad: el servidor **no firma un manifest ajeno**. Firmar hashes arbitrarios convierte al
 * endpoint en un oráculo de firma: cualquiera podría armar su propio pass.json (otro estilo, otro
 * organizationName, su propio webServiceURL) y hacérselo firmar con nuestro certificado de Apple.
 * Comprobado el 2026-09-12 contra producción antes de arreglarlo: devolvía 200 y Wallet aceptaba el pase.
 *
 * Entonces: el cliente manda los campos y los hashes de las tres imágenes del strip; el servidor arma él
 * mismo pass.json, calcula los hashes de sus propios iconos y del pass.json, y firma ese manifest.
 * Lo único que puede elegir quien llama es el texto de los campos. La foto nunca sale del teléfono: de ella
 * solo viaja un sha1, y no hay ningún otro camino que suba algo más.
 */
const STRIP_FILES = ['strip.png', 'strip@2x.png', 'strip@3x.png'];
const isSha1 = (h) => typeof h === 'string' && /^[0-9a-f]{40}$/.test(h);

export async function signClientPass({ cfg, certs, assets, fields, strips }) {
  if (!certs) throw Object.assign(new Error('Faltan certificados'), { status: 503 });
  if (!fields || typeof fields !== 'object') throw Object.assign(new Error('Faltan los campos'), { status: 400 });
  if (!clean(fields.apellido) || !clean(fields.nombres) || !clean(fields.dni)) throw Object.assign(new Error('apellido, nombres y dni son obligatorios'), { status: 400 });
  if (!strips || typeof strips !== 'object') throw Object.assign(new Error('Faltan los hashes del strip'), { status: 400 });
  const names = Object.keys(strips);
  if (names.length !== STRIP_FILES.length || !names.every((n) => STRIP_FILES.includes(n)) || !Object.values(strips).every(isSha1)) {
    throw Object.assign(new Error('Los hashes del strip son inválidos'), { status: 400 });
  }

  const serial = await passSerial(clean(fields.dni), clean(fields.ejemplar), cfg.passTypeId);
  const passJson = utf8(JSON.stringify(buildPassJson(cfg, fields, serial)));

  const manifest = {};
  for (const [name, bytes] of Object.entries(assets)) manifest[name] = await sha1hex(bytes);
  for (const name of STRIP_FILES) manifest[name] = strips[name];
  manifest['pass.json'] = await sha1hex(passJson);

  const manifestBytes = utf8(JSON.stringify(manifest));
  const signature = await signManifest(manifestBytes, certs);
  return { passJson, manifestBytes, signature, serial };
}

// ---------- Contenido del pase ----------
// Vive en public/ para que la PWA arme la misma vista previa con el mismo pass.json (una sola fuente de verdad).
import { clean, buildPassJson } from '../public/pass-json.js';

