/* Servidor local mínimo: sirve la PWA y firma pases .pkpass (node:http, sin framework, sin dependencias).
 * La misma lógica de armado/firma (server/pkpass.mjs) corre en Cloudflare Workers (worker/index.mjs).
 * Nada se persiste: la request entra, se firma, se responde, se olvida.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromBase64, signClientPass } from './pkpass.mjs';
import { PASS_ASSETS_B64 } from '../public/pass-assets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
loadEnv(path.join(ROOT, '.env'));

const cfg = {
  port: Number(process.env.PORT || 8787),
  passTypeId: process.env.PASS_TYPE_ID || 'pass.com.example.dni',
  teamId: process.env.TEAM_ID || 'ABCDE12345',
  orgName: process.env.ORG_NAME || 'DNI en Wallet',
  certDir: path.resolve(ROOT, process.env.CERT_DIR || 'certs'),
};

// ---------- Certificados (se leen una vez; si faltan, el servidor arranca igual y /api/sign devuelve 503) ----------
// Dos fuentes: archivos PEM en CERT_DIR (local) o variables WWDR_PEM_B64 / SIGNER_CERT_PEM_B64 / SIGNER_KEY_PEM_B64
// con el PEM en base64 (mismas que usa el Worker). Las variables tienen prioridad. La clave va sin passphrase.
let certs = null;
try {
  const fromEnv = (name) => (process.env[name] ? Buffer.from(process.env[name], 'base64').toString('utf8') : null);
  const fromFile = (f) => fs.readFileSync(path.join(cfg.certDir, f), 'utf8');
  certs = {
    wwdrPem: fromEnv('WWDR_PEM_B64') || fromFile('wwdr.pem'),
    signerCertPem: fromEnv('SIGNER_CERT_PEM_B64') || fromFile('signerCert.pem'),
    signerKeyPem: fromEnv('SIGNER_KEY_PEM_B64') || fromFile('signerKey.pem'),
  };
} catch (e) {
  console.warn(`[certs] No se encontraron certificados en ${cfg.certDir} ni en variables *_PEM_B64 (${e.message}). La PWA funciona, la firma no.`);
}

// Assets fijos del pase (icono obligatorio, logo opcional), embebidos para no depender de fs
const ASSETS = Object.fromEntries(Object.entries(PASS_ASSETS_B64).map(([k, v]) => [k, fromBase64(v)]));

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const PUBLIC = path.join(ROOT, 'public');

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Body demasiado grande'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'POST' && url.pathname === '/api/sign') {
      const body = JSON.parse((await readBody(req, 8192)).toString('utf8'));
      const out = await signClientPass({ cfg, certs, assets: ASSETS, fields: body.fields, strips: body.strips });
      const payload = JSON.stringify({
        passJson: Buffer.from(out.passJson).toString('utf8'),
        manifest: Buffer.from(out.manifestBytes).toString('utf8'),
        signature: Buffer.from(out.signature).toString('base64'),
        serial: out.serial,
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(payload);
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, signing: Boolean(certs), passTypeId: cfg.passTypeId, teamId: cfg.teamId, orgName: cfg.orgName }));
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      let p = path.normalize(decodeURIComponent(url.pathname));
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(PUBLIC, p);
      if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': p.includes('/icons/') ? 'public, max-age=86400' : 'no-cache' });
      return req.method === 'HEAD' ? res.end() : fs.createReadStream(file).pipe(res);
    }
    res.writeHead(405); res.end();
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('[pass]', e);
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(status >= 500 ? 'Error al generar el pase' : e.message);
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(cfg.port, () => console.log(`DNI en Wallet → http://localhost:${cfg.port}  (firma: ${certs ? 'lista' : 'sin certificados'})`));
}

// ---------- .env sin dependencias ----------
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] == null) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
