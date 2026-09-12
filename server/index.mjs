/* Servidor mínimo: sirve la PWA y firma pases .pkpass.
 * No usa framework (http nativo). Única dependencia: passkit-generator (firma PKCS#7 con el certificado del Pass Type ID).
 * Nada se persiste: la request entra, se firma, se responde, se olvida.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PKPass } from 'passkit-generator';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
loadEnv(path.join(ROOT, '.env'));

const cfg = {
  port: Number(process.env.PORT || 8787),
  passTypeId: process.env.PASS_TYPE_ID || 'pass.com.example.dni',
  teamId: process.env.TEAM_ID || 'ABCDE12345',
  orgName: process.env.ORG_NAME || 'DNI en Wallet',
  certDir: path.resolve(ROOT, process.env.CERT_DIR || 'certs'),
  keyPass: process.env.SIGNER_KEY_PASSPHRASE || undefined,
  maxBody: 20 * 1024 * 1024,
};

// ---------- Certificados (se leen una vez; si faltan, el servidor arranca igual y /api/pass devuelve 503) ----------
// Dos fuentes: archivos PEM en CERT_DIR (local) o variables WWDR_PEM_B64 / SIGNER_CERT_PEM_B64 / SIGNER_KEY_PEM_B64
// con el PEM en base64 (PaaS sin disco persistente: Render, Fly, Railway...). Las variables tienen prioridad.
let certs = null;
try {
  const fromEnv = (name) => (process.env[name] ? Buffer.from(process.env[name], 'base64') : null);
  const fromFile = (f) => fs.readFileSync(path.join(cfg.certDir, f));
  certs = {
    wwdr: fromEnv('WWDR_PEM_B64') || fromFile('wwdr.pem'),
    signerCert: fromEnv('SIGNER_CERT_PEM_B64') || fromFile('signerCert.pem'),
    signerKey: fromEnv('SIGNER_KEY_PEM_B64') || fromFile('signerKey.pem'),
    signerKeyPassphrase: cfg.keyPass,
  };
} catch (e) {
  console.warn(`[certs] No se encontraron certificados en ${cfg.certDir} ni en variables *_PEM_B64 (${e.message}). La PWA funciona, la firma no.`);
}

// Assets fijos del pase (icono obligatorio, logo opcional)
const ASSETS = Object.fromEntries(
  ['icon.png', 'icon@2x.png', 'icon@3x.png', 'logo.png', 'logo@2x.png', 'logo@3x.png']
    .map((f) => [f, fs.readFileSync(path.join(__dirname, 'assets', f))]),
);

// ---------- Construcción del pase ----------
const clean = (s, max = 80) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
const fmtDni = (d) => { const n = clean(d, 12).replace(/\D/g, ''); return n.replace(/\B(?=(\d{3})+(?!\d))/g, '.'); };

function buildPassJson(f, serial) {
  const apellido = clean(f.apellido), nombres = clean(f.nombres);
  const dni = fmtDni(f.dni);
  const raw = clean(f.raw, 400);
  const barcodeMessage = raw || `${clean(f.tramite)}@${apellido}@${nombres}@${clean(f.sexo, 1)}@${clean(f.dni, 12)}@${clean(f.ejemplar, 1)}@${clean(f.nacimiento, 10)}@${clean(f.emision, 10)}`;

  return {
    formatVersion: 1,
    passTypeIdentifier: cfg.passTypeId,
    teamIdentifier: cfg.teamId,
    serialNumber: serial,
    organizationName: cfg.orgName,
    description: `Copia de referencia del DNI ${dni}`,
    logoText: 'DNI · Copia',
    foregroundColor: 'rgb(234,241,248)',
    backgroundColor: 'rgb(22,61,102)',
    labelColor: 'rgb(170,190,210)',
    sharingProhibited: true,
    barcodes: [
      { format: raw ? 'PKBarcodeFormatPDF417' : 'PKBarcodeFormatQR', message: barcodeMessage, messageEncoding: 'iso-8859-1', altText: dni },
    ],
    // storeCard: el strip (frente|dorso) va debajo del encabezado. primaryFields se omite a propósito:
    // en storeCard se dibuja SOBRE el strip y taparía la foto.
    storeCard: {
      headerFields: [{ key: 'ejemplar', label: 'EJEMPLAR', value: clean(f.ejemplar, 1) || '—' }],
      secondaryFields: [
        { key: 'apellido', label: 'APELLIDO', value: apellido },
        { key: 'nombres', label: 'NOMBRES', value: nombres, textAlignment: 'PKTextAlignmentRight' },
      ],
      auxiliaryFields: [
        { key: 'dni', label: 'DNI', value: dni },
        { key: 'nac', label: 'NACIMIENTO', value: clean(f.nacimiento, 10) || '—' },
        { key: 'sexo', label: 'SEXO', value: clean(f.sexo, 1) || '—' },
        { key: 'ref', label: 'REFERENCIA', value: 'Sin validez oficial', textAlignment: 'PKTextAlignmentRight' },
      ],
      backFields: [
        { key: 'aviso', label: 'AVISO', value: 'Copia personal de referencia. No reemplaza al DNI físico ni al DNI Digital de Mi Argentina y no tiene validez legal.' },
        { key: 'tramite', label: 'Nº DE TRÁMITE', value: clean(f.tramite, 20) || '—' },
        { key: 'emision', label: 'FECHA DE EMISIÓN', value: clean(f.emision, 10) || '—' },
        { key: 'codigo', label: 'CÓDIGO PDF417', value: raw || '—' },
        { key: 'gen', label: 'GENERADO', value: new Date().toISOString().slice(0, 10) },
      ],
    },
  };
}

function dataUrlToPng(s) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(s || ''));
  if (!m) throw new Error('strip inválido (se espera data:image/png;base64)');
  return Buffer.from(m[1], 'base64');
}

export function createPass(fields, strips) {
  if (!certs) { const e = new Error('Faltan certificados'); e.status = 503; throw e; }
  if (!clean(fields.apellido) || !clean(fields.nombres) || !clean(fields.dni)) { const e = new Error('apellido, nombres y dni son obligatorios'); e.status = 400; throw e; }

  // Serial estable por documento: regenerar reemplaza el pase en Wallet en vez de duplicarlo. No se guarda en ningún lado.
  const serial = 'dni-' + crypto.createHash('sha256').update(`${clean(fields.dni)}|${clean(fields.ejemplar)}|${cfg.passTypeId}`).digest('hex').slice(0, 24);

  const pass = new PKPass(
    {
      ...ASSETS,
      'strip.png': dataUrlToPng(strips.strip1x),
      'strip@2x.png': dataUrlToPng(strips.strip2x),
      'strip@3x.png': dataUrlToPng(strips.strip3x),
      'pass.json': Buffer.from(JSON.stringify(buildPassJson(fields, serial))),
    },
    certs,
  );
  return { buffer: pass.getAsBuffer(), serial };
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const PUBLIC = path.join(ROOT, 'public');

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Body demasiado grande'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseForm(buf) {
  const p = new URLSearchParams(buf.toString('utf8'));
  return { fields: JSON.parse(p.get('fields') || '{}'), strips: { strip1x: p.get('strip1x'), strip2x: p.get('strip2x'), strip3x: p.get('strip3x') } };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'POST' && url.pathname === '/api/pass') {
      const { fields, strips } = parseForm(await readBody(req, cfg.maxBody));
      const { buffer, serial } = createPass(fields, strips);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.pkpass',
        'Content-Disposition': `attachment; filename="${serial}.pkpass"`,
        'Content-Length': buffer.length,
        'Cache-Control': 'no-store',
      });
      return res.end(buffer);
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, signing: Boolean(certs), passTypeId: cfg.passTypeId }));
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
