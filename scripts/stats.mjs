// Cuántos pases se firmaron, por día y por camino. Lee Workers Analytics Engine por la API SQL.
// Requiere CF_ACCOUNT_ID y CF_API_TOKEN (permiso «Account Analytics Read»).
const { CF_ACCOUNT_ID: cuenta, CF_API_TOKEN: token } = process.env;
if (!cuenta || !token) {
  console.error('Faltan CF_ACCOUNT_ID y CF_API_TOKEN (token con permiso Account Analytics Read).');
  process.exit(1);
}
const dias = Number(process.argv[2] || 30);
// sum(_sample_interval) y no count(): Analytics Engine puede muestrear, y cada fila vale por su intervalo.
const sql = `
  SELECT toStartOfDay(timestamp) AS dia, blob1 AS camino, SUM(_sample_interval) AS pases
  FROM dni_wallet_pases
  WHERE timestamp > NOW() - INTERVAL '${dias}' DAY
  GROUP BY dia, camino
  ORDER BY dia, camino
  FORMAT JSON`;
const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cuenta}/analytics_engine/sql`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
  body: sql,
});
if (!res.ok) {
  console.error(res.status, await res.text());
  process.exit(1);
}
const { data } = await res.json();
let total = 0;
for (const fila of data) {
  total += Number(fila.pases);
  console.log(`${fila.dia.slice(0, 10)}  ${fila.camino.padEnd(4)}  ${fila.pases}`);
}
console.log(`Total en ${dias} días: ${total}`);
