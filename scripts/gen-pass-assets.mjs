// Genera server/pass-assets.mjs con los PNG fijos del pase (icon/logo 1x/2x/3x) embebidos en base64.
// Así el mismo código corre en Node y en Cloudflare Workers (sin fs). Ejecutar: npm run assets
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'assets');
const names = ['icon.png', 'icon@2x.png', 'icon@3x.png', 'logo.png', 'logo@2x.png', 'logo@3x.png'];
const entries = names.map((n) => `  ${JSON.stringify(n)}: ${JSON.stringify(fs.readFileSync(path.join(dir, n)).toString('base64'))},`);
const out = `// GENERADO por scripts/gen-pass-assets.mjs a partir de server/assets/*.png — no editar a mano.\nexport const PASS_ASSETS_B64 = {\n${entries.join('\n')}\n};\n`;
fs.writeFileSync(path.join(dir, '..', 'pass-assets.mjs'), out);
console.log('server/pass-assets.mjs:', names.length, 'assets');
