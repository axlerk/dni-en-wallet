/* Contenido del pase: una sola fuente de verdad para el servidor (que firma) y para la PWA (que muestra la
 * vista previa). Antes la vista previa era HTML escrito a mano y se iba despegando de lo que realmente
 * llegaba a Wallet; ahora los dos leen el mismo pass.json.
 *
 * Módulo puro: sin fs, sin crypto, sin dependencias. El servidor lo importa desde ../public/pass-json.js y el
 * navegador lo carga como módulo desde la misma carpeta estática (extensión .js: algunos servidores mandan
 * .mjs como application/octet-stream y el navegador rechaza el módulo).
 */

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f]/g;
export const clean = (s, max = 80) => String(s ?? '').replace(CONTROL_CHARS, '').trim().slice(0, max);
export const fmtDni = (d) => { const n = clean(d, 12).replace(/\D/g, ''); return n.replace(/\B(?=(\d{3})+(?!\d))/g, '.'); };

/**
 * Wallet dibuja secondary + auxiliary en una sola fila y descarta en silencio lo que no entra.
 * Probado en un iPhone el 2026-09-12: con 2 secondary + 4 auxiliary mostró solo APELLIDO, NOMBRES, DNI y
 * NACIMIENTO. Por eso declaramos exactamente esta cantidad y el resto de los datos va al dorso.
 */
export const FRONT_FIELDS_MAX = 4;

/**
 * Colores de la bandera. `background` lo usa también el strip: pintar la foto sobre el mismo celeste
 * equivale a que la foto no tenga fondo propio (Wallet no admite transparencia confiable en el strip).
 * `foreground` pinta el logoText y los valores; `label` las etiquetas.
 */
export const COLORS = {
  background: 'rgb(116,172,223)',
  foreground: 'rgb(255,255,255)',
  label: 'rgb(226,240,250)',
  accent: 'rgb(246,180,14)', // amarillo del Sol de Mayo: el logo y el aviso del dorso
};

export function buildPassJson(cfg, f, serial, now = new Date()) {
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
    logoText: dni || 'DNI', // el número reemplaza a la palabra fija; sin DNI todavía cae al rótulo
    // Celeste de la bandera, texto blanco y el logo en amarillo: los tres colores, sin escudo ni Sol de Mayo.
    foregroundColor: COLORS.foreground,
    backgroundColor: COLORS.background,
    labelColor: COLORS.label,
    sharingProhibited: true,
    barcodes: [
      // La simbología la decide el lector, no el formulario: PDF417 en el DNI tarjeta, QR en el electrónico 2026.
      // Sin código leído se arma el mensaje con los campos y se emite como QR, que es lo que mejor tolera texto corto.
      { format: raw && f.codeFormat !== 'qr' ? 'PKBarcodeFormatPDF417' : 'PKBarcodeFormatQR', message: barcodeMessage, messageEncoding: 'iso-8859-1', altText: dni },
    ],
    // storeCard: el strip (la foto) va debajo del encabezado. primaryFields se omite a propósito:
    // en storeCard se dibuja SOBRE el strip y taparía la foto.
    storeCard: {
      // headerFields admite hasta 3 y es lo único que se puede sumar adelante sin tapar la foto.
      headerFields: [
        { key: 'sexo', label: 'SEXO', value: clean(f.sexo, 1) || '—' },
        { key: 'ejemplar', label: 'EJEMPLAR', value: clean(f.ejemplar, 1) || '—' },
      ],
      secondaryFields: [
        { key: 'nombre', label: 'APELLIDO Y NOMBRES', value: `${apellido} ${nombres}`.trim() || '—' },
      ],
      auxiliaryFields: [
        { key: 'nac', label: 'NACIMIENTO', value: clean(f.nacimiento, 10) || '—' },
        { key: 'tramite', label: 'Nº DE TRÁMITE', value: clean(f.tramite, 20) || '—' },
        { key: 'vencimiento', label: 'VENCIMIENTO', value: clean(f.vencimiento, 10) || '—' },
      ],
      // El dorso (botón "•••" en Wallet) guarda el registro completo en texto, incluido el descargo.
      backFields: [
        { key: 'aviso', label: 'AVISO', value: 'Copia personal de referencia. No reemplaza al DNI físico ni al DNI Digital de Mi Argentina y no tiene validez legal.' },
        { key: 'nombre', label: 'APELLIDO Y NOMBRES', value: `${apellido} ${nombres}`.trim() || '—' },
        { key: 'sexo', label: 'SEXO', value: clean(f.sexo, 1) || '—' },
        { key: 'ejemplar', label: 'EJEMPLAR', value: clean(f.ejemplar, 1) || '—' },
        { key: 'tramite', label: 'Nº DE TRÁMITE', value: clean(f.tramite, 20) || '—' },
        // Solo se agregan los campos que el código realmente traía: el formato nuevo tiene CUIL y no vencimiento,
        // el viejo (DNI 2009-2012) tiene vencimiento y nacionalidad.
        ...(clean(f.cuil, 15) ? [{ key: 'cuil', label: 'CUIL', value: clean(f.cuil, 15) }] : []),
        ...(clean(f.nacionalidad, 40) ? [{ key: 'nacionalidad', label: 'NACIONALIDAD', value: clean(f.nacionalidad, 40) }] : []),
        { key: 'emision', label: 'FECHA DE EMISIÓN', value: clean(f.emision, 10) || '—' },
        ...(clean(f.vencimiento, 10) ? [{ key: 'vencimiento', label: 'FECHA DE VENCIMIENTO', value: clean(f.vencimiento, 10) }] : []),
        { key: 'codigo', label: f.codeFormat === 'qr' ? 'CÓDIGO QR' : 'CÓDIGO PDF417', value: raw || '—' },
        // El DNI Digital de verdad vive en Mi Argentina. Los enlaces solo funcionan en el dorso del pase,
        // a través de attributedValue. El esquema miargentina:// abre la app directamente (probado en un
        // iPhone el 2026-09-12); universal link no tienen. El texto plano deja el sitio a la vista por si
        // la app no está instalada.
        {
          key: 'miargentina',
          label: 'DNI DIGITAL OFICIAL',
          value: 'App Mi Argentina — mi.argentina.gob.ar',
          attributedValue: '<a href="miargentina://">Abrir la app Mi Argentina</a>',
        },
        { key: 'gen', label: 'GENERADO', value: now.toISOString().slice(0, 10) },
      ],
    },
  };
}

/** Los 4 campos que Wallet realmente dibuja en la fila del frente, en orden. */
export function frontRowFields(passJson) {
  const s = passJson.storeCard;
  return [...(s.secondaryFields || []), ...(s.auxiliaryFields || [])].slice(0, FRONT_FIELDS_MAX);
}
