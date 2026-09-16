/* Cloudflare Worker: firma pases .pkpass. La PWA estática la sirve Workers Static Assets (wrangler.toml → [assets]),
 * así que acá solo llegan /api/* y lo que no matchea ningún archivo.
 * Nada se persiste. Certificados por secrets en base64: WWDR_PEM_B64, SIGNER_CERT_PEM_B64, SIGNER_KEY_PEM_B64.
 */
import { createPkpass, parsePassForm, fromBase64, signClientPass } from '../server/pkpass.mjs';
import { PASS_ASSETS_B64 } from '../public/pass-assets.js';

const ASSETS = Object.fromEntries(Object.entries(PASS_ASSETS_B64).map(([k, v]) => [k, fromBase64(v)]));
const td = new TextDecoder();
const toBase64 = (u8) => btoa(String.fromCharCode(...u8));
const MAX_BODY = 20 * 1024 * 1024;

function certsFrom(env) {
  if (!env.WWDR_PEM_B64 || !env.SIGNER_CERT_PEM_B64 || !env.SIGNER_KEY_PEM_B64) return null;
  return {
    wwdrPem: td.decode(fromBase64(env.WWDR_PEM_B64)),
    signerCertPem: td.decode(fromBase64(env.SIGNER_CERT_PEM_B64)),
    signerKeyPem: td.decode(fromBase64(env.SIGNER_KEY_PEM_B64)),
  };
}

// Contador de pases firmados: un evento por firma exitosa, con el nombre del camino y nada más.
// Sin IP, sin campos del documento, sin serial. Si el binding no está (wrangler dev), no cuenta.
const contar = (env, camino) => env.PASES?.writeDataPoint({ blobs: [camino], indexes: [camino] });

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
      // Camino principal: el teléfono arma el pase y acá solo entran los campos y los hashes del strip.
      if (req.method === 'POST' && url.pathname === '/api/sign') {
        // Solo desde nuestra propia página: no frena a curl, pero sí evita que otro sitio use el firmador
        // desde el navegador de un visitante.
        const origin = req.headers.get('Origin');
        if (origin && origin !== url.origin) return text('Origen no permitido', 403);
        // Freno por IP. Si el binding no está (wrangler dev viejo), seguimos: no es una barrera de seguridad.
        const ip = req.headers.get('CF-Connecting-IP') || 'sin-ip';
        const allowed = env.SIGN_LIMITER ? (await env.SIGN_LIMITER.limit({ key: ip })).success : true;
        if (!allowed) return text('Demasiados pases seguidos, probá en unos segundos', 429);
        const raw = await req.text();
        if (raw.length > 8192) return text('Body demasiado grande', 413);
        let body;
        try { body = JSON.parse(raw); } catch { return text('Body no es JSON', 400); }
        const out = await signClientPass({ cfg, certs: certsFrom(env), assets: ASSETS, fields: body.fields, strips: body.strips });
        contar(env, 'sign');
        return json({
          passJson: td.decode(out.passJson),
          manifest: td.decode(out.manifestBytes),
          signature: toBase64(out.signature),
          serial: out.serial,
        });
      }
      // Camino de respaldo: sube la imagen ya armada y el servidor hace todo.
      if (req.method === 'POST' && url.pathname === '/api/pass') {
        const len = Number(req.headers.get('content-length') || 0);
        if (len > MAX_BODY) return text('Body demasiado grande', 413);
        const { fields, strips } = parsePassForm(await req.text());
        const { bytes, serial } = await createPkpass({ cfg, certs: certsFrom(env), assets: ASSETS, fields, strips });
        contar(env, 'pass');
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
