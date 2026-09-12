/* Cloudflare Worker: firma pases .pkpass. La PWA estática la sirve Workers Static Assets (wrangler.toml → [assets]),
 * así que acá solo llegan /api/* y lo que no matchea ningún archivo.
 * Nada se persiste. Certificados por secrets en base64: WWDR_PEM_B64, SIGNER_CERT_PEM_B64, SIGNER_KEY_PEM_B64.
 */
import { createPkpass, parsePassForm, fromBase64, signClientManifest } from '../server/pkpass.mjs';
import { PASS_ASSETS_B64 } from '../public/pass-assets.js';

const ASSETS = Object.fromEntries(Object.entries(PASS_ASSETS_B64).map(([k, v]) => [k, fromBase64(v)]));
const td = new TextDecoder();
const MAX_BODY = 20 * 1024 * 1024;

function certsFrom(env) {
  if (!env.WWDR_PEM_B64 || !env.SIGNER_CERT_PEM_B64 || !env.SIGNER_KEY_PEM_B64) return null;
  return {
    wwdrPem: td.decode(fromBase64(env.WWDR_PEM_B64)),
    signerCertPem: td.decode(fromBase64(env.SIGNER_CERT_PEM_B64)),
    signerKeyPem: td.decode(fromBase64(env.SIGNER_KEY_PEM_B64)),
  };
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const text = (msg, status) => new Response(msg, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cfg = { passTypeId: env.PASS_TYPE_ID, teamId: env.TEAM_ID, orgName: env.ORG_NAME || 'DNI en Wallet' };
    try {
      if (req.method === 'GET' && url.pathname === '/api/health') {
        return json({ ok: true, signing: Boolean(certsFrom(env)), passTypeId: cfg.passTypeId, teamId: cfg.teamId, orgName: cfg.orgName });
      }
      // Camino principal: el teléfono arma el pase y acá solo se firma el manifest (hashes, sin foto).
      if (req.method === 'POST' && url.pathname === '/api/sign') {
        const manifest = await req.text();
        const signature = await signClientManifest(manifest, certsFrom(env));
        return new Response(signature, {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(signature.length), 'Cache-Control': 'no-store' },
        });
      }
      // Camino de respaldo: sube la imagen ya armada y el servidor hace todo.
      if (req.method === 'POST' && url.pathname === '/api/pass') {
        const len = Number(req.headers.get('content-length') || 0);
        if (len > MAX_BODY) return text('Body demasiado grande', 413);
        const { fields, strips } = parsePassForm(await req.text());
        const { bytes, serial } = await createPkpass({ cfg, certs: certsFrom(env), assets: ASSETS, fields, strips });
        return new Response(bytes, {
          status: 200,
          headers: {
            'Content-Type': 'application/vnd.apple.pkpass',
            'Content-Disposition': `attachment; filename="${serial}.pkpass"`,
            'Content-Length': String(bytes.length),
            'Cache-Control': 'no-store',
          },
        });
      }
      return text('Not found', 404);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error('[pass]', e);
      return text(status >= 500 ? 'Error al generar el pase' : e.message, status);
    }
  },
};
