/* DNI en Wallet — frontend en JS puro.
 * Flujo: foto frente → foto dorso (el PDF417 se busca en las dos caras) → encuadre (arrastrar / pellizcar) → revisar datos → strip (frente|dorso) → POST → .pkpass
 * Todo ocurre en el teléfono, incluido el armado del .pkpass: al servidor solo se le manda el manifest (hashes)
 * para que lo firme con el certificado de Apple. El camino viejo (subir la imagen a /api/pass) queda de respaldo.
 */
import { buildPassJson, frontRowFields, COLORS } from './pass-json.js';
import { zipStore, sha1hex, utf8, fromBase64 } from './pkpass-build.js';
import { PASS_ASSETS_B64 } from './pass-assets.js';

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // ---------- Estado ----------
  // Cada lado: { img, zoom, cx, cy }. zoom ≥ 1 es relativo al encuadre "cover"; (cx, cy) es el centro del recorte
  // en coordenadas normalizadas de la imagen (0..1). Con zoom 1 y centro 0.5 es el recorte centrado de antes.
  const state = {
    front: null,
    back: null,
    frontOnly: true,    // armar el pase solo con el frente (por defecto; el dorso sigue sirviendo para leer el código)
    scanning: false,    // buscando el PDF417
    building: false,    // armando el pase para Wallet
    cuilTouched: false, // el usuario editó el CUIL a mano: dejamos de calcularlo
    cuilAuto: false,
    nacTouched: false,  // ídem para la nacionalidad sugerida
    vencTouched: false, // ídem para el vencimiento calculado
    scanned: false,   // ya se leyó el PDF417 en alguna de las dos caras
    fields: { apellido: '', nombres: '', dni: '', sexo: '', nacimiento: '', ejemplar: '', tramite: '', emision: '', vencimiento: '', nacionalidad: '', cuil: '', raw: '' },
  };

  // Strip de storeCard: 375×123 pt en 1x/2x/3x.
  // El recorte de cada cara mantiene la proporción real de la tarjeta (ID-1, 85.6×54 mm), así no se corta nada:
  // dos caras entran como 186×117 con una franja de 3 pt arriba y abajo; solo el frente entra como 195×123 centrado.
  // Las franjas se pintan del color de fondo del pase, así que no se ven.
  // El strip se pinta con el mismo color de fondo del pase: la foto queda sin fondo propio, flotando sobre el celeste.
  // Wallet recorta la fila de campos a 4 (probado en iPhone el 2026-09-12: con 6 campos descartó SEXO y REFERENCIA),
  // así que el resto de los datos vive en el dorso del pase, no encima de la foto.
  // `radius`: mismo redondeo que el recuadro del código de barras que dibuja Wallet abajo del pase (~8 pt).
  const STRIP = { w: 375, h: 123, gap: 3, radius: 8, bg: COLORS.background };
  const CARD_RATIO = 85.6 / 54; // 1.585…
  const ZOOM = { min: 1, max: 5 };

  // ---------- Utilidades de imagen ----------
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve(img); // Safari aplica la orientación EXIF al <img> al dibujar en canvas
      img.onerror = reject;
      img.src = url;
    });
  }

  /**
   * Región de la imagen (px de imagen) visible en una caja w×h según zoom y centro.
   * Si el recorte se sale del borde, corrige cx/cy en el estado para que el encuadre nunca muestre fondo.
   * Devuelve también `s`: px de caja por px de imagen.
   */
  function cropRect(side, w, h) {
    const iw = side.img.naturalWidth, ih = side.img.naturalHeight;
    const s = Math.max(w / iw, h / ih) * side.zoom;
    const vw = w / s, vh = h / s;
    const sx = clamp(side.cx * iw - vw / 2, 0, iw - vw);
    const sy = clamp(side.cy * ih - vh / 2, 0, ih - vh);
    side.cx = (sx + vw / 2) / iw;
    side.cy = (sy + vh / 2) / ih;
    return { sx, sy, vw, vh, s };
  }

  /** Camino rectangular con esquinas redondeadas; `roundRect` no está en Safari viejos. */
  function roundRectPath(ctx, x, y, w, h, r) {
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(x, y, w, h, rad); return; }
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }

  /** Dibuja el recorte de `side` en el rect (x,y,w,h) del contexto. `radius` redondea las esquinas. */
  function drawCrop(ctx, side, x, y, w, h, radius = 0) {
    const r = cropRect(side, w, h);
    if (!radius) { ctx.drawImage(side.img, r.sx, r.sy, r.vw, r.vh, x, y, w, h); return; }
    ctx.save();
    roundRectPath(ctx, x, y, w, h, radius);
    ctx.clip();
    ctx.drawImage(side.img, r.sx, r.sy, r.vw, r.vh, x, y, w, h);
    ctx.restore();
  }

  /** Rectángulo de proporción `ratio` centrado dentro de (x, y, w, h), sin recortar. */
  function fitRect(x, y, w, h, ratio) {
    const rw = Math.min(w, h * ratio), rh = rw / ratio;
    return { x: x + (w - rw) / 2, y: y + (h - rh) / 2, w: rw, h: rh };
  }

  /** True si el pase se arma solo con el frente (por elección o porque todavía no hay dorso). */
  const onlyFront = () => state.frontOnly || !state.back;

  /** Compone el strip: la foto (o las dos) centrada sobre blanco, sin nada encima. */
  function composeStrip(scale) {
    const c = document.createElement('canvas');
    c.width = STRIP.w * scale; c.height = STRIP.h * scale;
    const ctx = c.getContext('2d');
    ctx.fillStyle = STRIP.bg;
    ctx.fillRect(0, 0, c.width, c.height);
    const draw = (side, x, w) => {
      if (!side) return;
      const r = fitRect(x, 0, w, c.height, CARD_RATIO);
      drawCrop(ctx, side, r.x, r.y, r.w, r.h, STRIP.radius * scale);
    };
    if (onlyFront()) {
      draw(state.front, 0, c.width);
    } else {
      const gap = Math.round(STRIP.gap * scale);
      const half = (c.width - gap) / 2;
      draw(state.front, 0, half);
      draw(state.back, half + gap, half);
    }
    return c;
  }

  function renderPreviewStrip() {
    const target = $('stripCanvas');
    const src = composeStrip(3);
    target.width = src.width; target.height = src.height;
    target.getContext('2d').drawImage(src, 0, 0);
  }

  /** Redibuja el marco de captura de un lado con el recorte actual, a resolución de pantalla. */
  function renderFrame(which) {
    const side = state[which];
    if (!side) return;
    const c = $(which + 'Canvas');
    const W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const pw = Math.round(W * dpr), ph = Math.round(H * dpr);
    if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    drawCrop(ctx, side, 0, 0, W, H);
  }

  // Los gestos disparan muchos eventos por segundo; agrupo el redibujado por frame.
  const pendingFrames = new Set();
  let raf = 0;
  function scheduleRender(which) {
    pendingFrames.add(which);
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      for (const w of pendingFrames) renderFrame(w);
      pendingFrames.clear();
      renderPreviewStrip();
    });
  }

  // ---------- Encuadre: arrastrar / pellizcar / rueda ----------
  /** Desplaza el recorte `dx,dy` px CSS del marco (el dedo arrastra la imagen, el centro se mueve al revés). */
  function panBy(which, dx, dy) {
    const side = state[which];
    const c = $(which + 'Canvas');
    const { s } = cropRect(side, c.clientWidth, c.clientHeight);
    side.cx -= dx / (s * side.img.naturalWidth);
    side.cy -= dy / (s * side.img.naturalHeight);
  }

  /** Multiplica el zoom por `factor` manteniendo fijo el punto de la imagen que está bajo (mx,my) px CSS del marco. */
  function zoomAt(which, factor, mx, my) {
    const side = state[which];
    const c = $(which + 'Canvas');
    const W = c.clientWidth, H = c.clientHeight;
    const iw = side.img.naturalWidth, ih = side.img.naturalHeight;
    const before = cropRect(side, W, H);
    const px = before.sx + mx / before.s, py = before.sy + my / before.s;
    side.zoom = clamp(side.zoom * factor, ZOOM.min, ZOOM.max);
    const s = Math.max(W / iw, H / ih) * side.zoom;
    side.cx = (px - mx / s + W / (2 * s)) / iw;
    side.cy = (py - my / s + H / (2 * s)) / ih;
  }

  function resetCrop(which) {
    const side = state[which];
    if (!side) return;
    side.zoom = 1; side.cx = 0.5; side.cy = 0.5;
    scheduleRender(which);
  }

  function wireGestures(which) {
    const c = $(which + 'Canvas');
    const pts = new Map(); // pointerId → {x, y} en px CSS del marco
    const local = (e) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

    c.addEventListener('pointerdown', (e) => {
      if (!state[which]) return;
      pts.set(e.pointerId, local(e));
      try { c.setPointerCapture(e.pointerId); } catch { /* ids sintéticos (tests) no se pueden capturar; el gesto funciona igual */ }
      e.preventDefault();
    });
    c.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      const prev = pts.get(e.pointerId);
      const now = local(e);
      if (pts.size === 1) {
        panBy(which, now.x - prev.x, now.y - prev.y);
      } else if (pts.size === 2) {
        const other = [...pts.entries()].find(([id]) => id !== e.pointerId)[1];
        const d0 = Math.hypot(prev.x - other.x, prev.y - other.y);
        const d1 = Math.hypot(now.x - other.x, now.y - other.y);
        const m0 = { x: (prev.x + other.x) / 2, y: (prev.y + other.y) / 2 };
        const m1 = { x: (now.x + other.x) / 2, y: (now.y + other.y) / 2 };
        panBy(which, m1.x - m0.x, m1.y - m0.y);
        if (d0 > 0) zoomAt(which, d1 / d0, m1.x, m1.y);
      }
      pts.set(e.pointerId, now);
      scheduleRender(which);
    });
    const end = (e) => pts.delete(e.pointerId);
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('lostpointercapture', end);

    // Escritorio: rueda = zoom en el cursor. Doble clic/tap = volver al encuadre inicial.
    c.addEventListener('wheel', (e) => {
      if (!state[which]) return;
      e.preventDefault();
      const p = local(e);
      zoomAt(which, Math.exp(-e.deltaY * 0.002), p.x, p.y);
      scheduleRender(which);
    }, { passive: false });
    c.addEventListener('dblclick', () => resetCrop(which));
    // Safari: que el pellizco no haga zoom de página (touch-action:none ya lo cubre en iOS 13+; esto es cinturón y tiradores).
    c.addEventListener('gesturestart', (e) => e.preventDefault());
  }

  // ---------- PDF417 ----------
  /**
   * Dos formatos en circulación, con campos separados por "@". Se distinguen por la cantidad de campos,
   * no por la cara del documento: según la generación el código está en el frente o en el dorso, así que
   * la app escanea las dos fotos (ver scanSide).
   *
   *  - Nuevo (DNI tarjeta 2012+), 9 campos:
   *      tramite@apellido@nombres@sexo@dni@ejemplar@nacimiento@emision@cuil
   *    No trae fecha de vencimiento.
   *  - Viejo (DNI tarjeta 2009-2012), 16-17 campos, arranca con "@":
   *      @dni@ejemplar@?@apellido@nombres@nacionalidad@nacimiento@sexo@emision@?@?@vencimiento@...
   */
  const isDate = (s) => /^\d{2}\/\d{2}\/\d{4}$/.test(String(s || '').trim());
  /**
   * El formato nuevo cierra con 3 dígitos: los 2 del prefijo del CUIL y el dígito verificador.
   * Reconstruimos el CUIL completo y lo validamos con el módulo 11; si no cierra, no lo mostramos.
   */
  const CUIL_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  /** Dígito verificador módulo 11. Devuelve `null` cuando el resto es 1: ahí el prefijo pasa a 23. */
  function cuilCheckDigit(pre, n) {
    const sum = (pre + n).split('').reduce((a, d, i) => a + Number(d) * CUIL_WEIGHTS[i], 0);
    const r = sum % 11;
    return r === 0 ? 0 : (r === 1 ? null : 11 - r);
  }

  function cuilFrom(tail, dni) {
    const t = String(tail || '').trim(), n = String(dni || '').padStart(8, '0');
    if (!/^\d{3}$/.test(t) || !/^\d{8}$/.test(n)) return '';
    const pre = t.slice(0, 2), dv = Number(t[2]);
    if (!['20', '23', '24', '27', '30', '33', '34'].includes(pre)) return '';
    const d = cuilCheckDigit(pre, n);
    if (d !== null && d !== dv) return ''; // con resto 1 hay casos especiales: aceptamos lo que diga el código
    return `${pre}-${n}-${dv}`;
  }
  const onlyLetter = (s) => (/^[A-Za-z]$/.test(String(s || '').trim()) ? String(s).trim().toUpperCase() : '');
  /**
   * El sexo no siempre viene como letra. El código del DNI Digital de Mi Argentina lo trae como número
   * (un usuario con "Sexo M" en su documento tenía un 1 en ese campo, 2026-09-12), que es el ISO 5218:
   * 1 = masculino, 2 = femenino. El 0 y el 9 del estándar son "desconocido" y "no aplica": los dejamos vacíos
   * para que se elija a mano.
   */
  const SEXO_TOKENS = { M: 'M', F: 'F', X: 'X', 1: 'M', 2: 'F' };
  const parseSexo = (v) => SEXO_TOKENS[String(v ?? '').trim().toUpperCase()] || '';

  const onlyDigits = (s) => String(s || '').replace(/\D/g, '');

  function parseDni(raw) {
    const t = String(raw || '').trim();
    if (!t.includes('@')) return null;
    const p = t.split('@').map((s) => s.trim());
    // El formato viejo tiene muchos más campos; el nuevo son 9 (a veces 8 sin CUIL).
    const f = p.length >= 14
      ? { dni: onlyDigits(p[1]), ejemplar: onlyLetter(p[2]), apellido: p[4], nombres: p[5], nacionalidad: p[6] || '', nacimiento: p[7], sexo: parseSexo(p[8]), emision: p[9], vencimiento: isDate(p[12]) ? p[12] : '', tramite: '', cuil: '' }
      : p.length >= 8
        ? { tramite: onlyDigits(p[0]), apellido: p[1], nombres: p[2], sexo: parseSexo(p[3]), dni: onlyDigits(p[4]), ejemplar: onlyLetter(p[5]), nacimiento: p[6], emision: p[7], vencimiento: '', nacionalidad: '', cuil: cuilFrom(p[8], onlyDigits(p[4])) }
        : null;
    if (!f || !f.dni || !f.apellido || !f.nombres) return null;
    if (!isDate(f.nacimiento)) f.nacimiento = '';
    if (!isDate(f.emision)) f.emision = '';
    return { ...f, raw: t };
  }

  async function decodeWithNative(canvas) {
    if (!('BarcodeDetector' in window)) return null;
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats?.();
      if (formats && !formats.includes('pdf417')) return null;
      const det = new window.BarcodeDetector({ formats: ['pdf417'] });
      const res = await det.detect(canvas);
      return res?.[0]?.rawValue || null;
    } catch { return null; }
  }

  /**
   * Decodifica leyendo el canvas directamente. La otra vía de la librería, decodeFromImageUrl, serializa un PNG
   * y lo vuelve a decodificar en cada intento, y son 16 intentos por foto (4 escalas × 4 rotaciones).
   * `reader.decode(canvas)` no sirve: arma su propio canvas de captura con tamaño 0 y tira IndexSizeError.
   */
  function decodeWithZXing(canvas) {
    const Z = window.ZXing;
    if (!Z?.HTMLCanvasElementLuminanceSource || !Z?.PDF417Reader) return null;
    try {
      const source = new Z.HTMLCanvasElementLuminanceSource(canvas);
      const bitmap = new Z.BinaryBitmap(new Z.HybridBinarizer(source));
      return new Z.PDF417Reader().decode(bitmap)?.getText?.() || null;
    } catch { return null; }
  }

  /** Reintenta a varias escalas y rotaciones — las fotos de celular rara vez salen perfectas. Usa la foto completa, no el recorte. */
  async function decodePdf417(img) {
    const base = Math.max(img.naturalWidth, img.naturalHeight);
    const scales = [1600, 1200, 900, 2200].map((px) => Math.min(1, px / base));
    const rotations = [0, 180, 90, 270];
    for (const s of scales) {
      for (const rot of rotations) {
        const c = document.createElement('canvas');
        const w = Math.round(img.naturalWidth * s), h = Math.round(img.naturalHeight * s);
        const swap = rot === 90 || rot === 270;
        c.width = swap ? h : w; c.height = swap ? w : h;
        // willReadFrequently: el decodificador lee todos los píxeles; sin esto cada lectura baja de la GPU y el
        // barrido de 16 intentos se vuelve varias veces más lento.
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.translate(c.width / 2, c.height / 2);
        ctx.rotate((rot * Math.PI) / 180);
        ctx.drawImage(img, -w / 2, -h / 2, w, h);
        const text = (await decodeWithNative(c)) || (await decodeWithZXing(c));
        if (text) return text;
      }
    }
    return null;
  }

  // ---------- Fechas: separadores automáticos ----------
  // HTML no tiene máscaras, y <input type="date"> en iOS abre una rueda incómoda para una fecha de nacimiento
  // (además su valor es AAAA-MM-DD y el DNI usa DD/MM/AAAA). Se escriben solo números y las barras se ponen solas.
  const dateIds = ['nacimiento', 'emision', 'vencimiento'];

  const maskDate = (v) => {
    const d = String(v).replace(/\D/g, '').slice(0, 8);
    return [d.slice(0, 2), d.slice(2, 4), d.slice(4, 8)].filter(Boolean).join('/');
  };

  /** Fecha real: rechaza 31/02, el mes 13 y los años fuera de rango. Vacío es válido: todos los campos son opcionales. */
  function dateError(v) {
    const s = String(v).trim();
    if (!s) return '';
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
    if (!m) return 'Completá DD/MM/AAAA';
    const dd = Number(m[1]), mm = Number(m[2]), yyyy = Number(m[3]);
    const d = new Date(Date.UTC(yyyy, mm - 1, dd));
    if (d.getUTCDate() !== dd || d.getUTCMonth() !== mm - 1 || d.getUTCFullYear() !== yyyy) return 'Esa fecha no existe';
    if (yyyy < 1900 || yyyy > 2100) return 'Revisá el año';
    return '';
  }

  /** Mensaje debajo de un campo. `kind`: 'err' (rojo) o 'note' (gris). */
  function setFieldMsg(el, msg, kind = 'err') {
    el.setAttribute('aria-invalid', msg && kind === 'err' ? 'true' : 'false');
    let node = el.parentElement.querySelector('.err, .note');
    if (!msg) { node?.remove(); return; }
    if (!node) { node = document.createElement('span'); el.parentElement.append(node); }
    node.className = kind;
    node.textContent = msg;
  }

  function wireDateField(el) {
    // Borrar encima de una barra tiene que llevarse también el dígito anterior.
    el.addEventListener('beforeinput', (e) => {
      if (e.inputType !== 'deleteContentBackward' || el.selectionStart !== el.selectionEnd) return;
      const i = el.selectionStart;
      if (i > 1 && el.value[i - 1] === '/') {
        e.preventDefault();
        el.setRangeText('', i - 2, i, 'end');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    el.addEventListener('input', () => {
      const caret = el.selectionStart ?? el.value.length;
      const digitsBefore = el.value.slice(0, caret).replace(/\D/g, '').length;
      const formatted = maskDate(el.value);
      if (formatted !== el.value) {
        el.value = formatted;
        let pos = 0, seen = 0;
        while (pos < formatted.length && seen < digitsBefore) { if (/\d/.test(formatted[pos])) seen += 1; pos += 1; }
        try { el.setSelectionRange(pos, pos); } catch { /* algunos navegadores no dejan mover el cursor acá */ }
      }
      // Mientras escribe no lo retamos: el error aparece recién con la fecha completa o al salir del campo.
      setFieldMsg(el, el.value.length === 10 ? dateError(el.value) : '');
    });
    el.addEventListener('blur', () => setFieldMsg(el, dateError(el.value)));
  }

  // ---------- CUIL calculado ----------
  /**
   * El CUIL sale de una fórmula pública, no de un padrón: prefijo por sexo (20 varón / 27 mujer) + DNI +
   * dígito verificador módulo 11, y si el resto da 1 el prefijo pasa a 23. Comprobado el 2026-09-12 contra el
   * generador oficial de hjunin.ms.gba.gov.ar: 8 de 8 casos iguales, incluido el salto a 23.
   * Es un valor probable: ANSES puede haber asignado otro prefijo en casos raros (duplicados, extranjeros).
   */
  function cuilFromDniSexo(dni, sexo) {
    const n = onlyDigits(dni).padStart(8, '0');
    if (n.length !== 8) return '';
    let pre = { M: '20', F: '27' }[onlyLetter(sexo)];
    if (!pre) return '';
    let d = cuilCheckDigit(pre, n);
    if (d === null) { pre = '23'; d = cuilCheckDigit(pre, n); }
    return d === null ? '' : `${pre}-${n}-${d}`;
  }

  /**
   * Nacionalidad sin OCR. El código nuevo no la trae (el viejo sí, y en ese caso no tocamos nada).
   * La numeración manda: la serie de 9x millones es la de extranjeros y naturalizados
   * (Wikipedia, "Argentine Foreigner's Identity card": «Number started with 9, instead of 8 and before as
   * nationals»; la prensa local ubica ahí los 92 millones), y los recién nacidos argentinos van por 70 millones.
   * Con un número por debajo de 90 millones sugerimos ARGENTINA; por encima no adivinamos el país y lo dejamos vacío.
   */
  const nacionalidadSugerida = (dni) => {
    const n = Number(onlyDigits(dni));
    return n && n < 90000000 ? 'ARGENTINA' : '';
  };

  function maybeFillNacionalidad() {
    const el = $('f_nacionalidad');
    if (state.nacTouched || el.value.trim()) return;
    const v = nacionalidadSugerida(state.fields.dni);
    if (!v) { setFieldMsg(el, ''); return; } // sin sugerencia no dejamos la nota colgada
    el.value = v;
    state.fields.nacionalidad = v;
    setFieldMsg(el, 'Sugerida por el número de DNI', 'note');
  }

  /**
   * Vencimiento cuando el código no lo trae (formato nuevo). Un DNI de mayores de 14 vale 15 años desde la
   * emisión (argentina.gob.ar y prensa local; el documento del autor lo confirma: vence a los 15 años de la emisión).
   *
   * Pero eso no vale para todos: la residencia temporaria se otorga por hasta 3 años y el DNI vence con ella.
   * Por eso solo calculamos cuando hay motivo para creer que es un DNI de argentino: número por debajo de la
   * serie 9x millones (que es la de extranjeros y naturalizados) y, si el código trajo nacionalidad, que diga
   * ARGENTINA. En cualquier otro caso se deja vacío: es mejor un campo en blanco que una fecha inventada.
   */
  function vencimientoSugerido(emision, nacimiento, dni, nacionalidad) {
    const n8 = Number(onlyDigits(dni));
    if (!n8 || n8 >= 90000000) return '';
    const nac = String(nacionalidad || '').trim().toUpperCase();
    if (nac && nac !== 'ARGENTINA') return '';
    const parse = (v) => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(v || '').trim()); return m ? { d: +m[1], mo: +m[2], y: +m[3] } : null; };
    const e = parse(emision), b = parse(nacimiento);
    if (!e || !b) return '';
    const edad = e.y - b.y - (e.mo < b.mo || (e.mo === b.mo && e.d < b.d) ? 1 : 0);
    if (edad < 14) return ''; // menores: la renovación va por edad (5-8 y 14 años)
    const y = e.y + 15;
    const existe = new Date(Date.UTC(y, e.mo - 1, e.d)).getUTCDate() === e.d; // 29/02 + 15 puede no existir
    return existe ? `${String(e.d).padStart(2, '0')}/${String(e.mo).padStart(2, '0')}/${y}` : '';
  }

  function maybeFillVencimiento() {
    const el = $('f_vencimiento');
    if (state.vencTouched || el.value.trim()) return;
    const v = vencimientoSugerido(state.fields.emision, state.fields.nacimiento, state.fields.dni, state.fields.nacionalidad);
    if (!v) { setFieldMsg(el, ''); return; }
    el.value = v;
    state.fields.vencimiento = v;
    setFieldMsg(el, 'Calculado: 15 años desde la emisión', 'note');
  }

  function maybeFillCuil() {
    const el = $('f_cuil');
    if (state.cuilTouched || el.value.trim()) return;
    const c = cuilFromDniSexo(state.fields.dni, state.fields.sexo);
    if (!c) { setFieldMsg(el, ''); return; }
    el.value = c;
    state.fields.cuil = c;
    state.cuilAuto = true;
    setFieldMsg(el, 'Calculado con el DNI y el sexo', 'note');
  }

  // ---------- UI ----------
  const fieldIds = ['apellido', 'nombres', 'dni', 'sexo', 'nacimiento', 'ejemplar', 'tramite', 'emision', 'vencimiento', 'nacionalidad', 'cuil', 'raw'];

  function setStatus(el, text, kind) {
    el.hidden = !text;
    el.textContent = text || '';
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  function fillForm(f) {
    for (const k of fieldIds) if (f[k] != null) $('f_' + k).value = f[k];
    readForm();
  }

  function readForm() {
    for (const k of fieldIds) state.fields[k] = $('f_' + k).value.trim();
    maybeFillCuil();
    maybeFillNacionalidad();
    maybeFillVencimiento();
    renderPreviewFields();
    updateCta();
  }

  /**
   * La vista previa se dibuja desde el mismo pass.json que después firma el servidor: los campos, las etiquetas,
   * los colores y el dorso salen de ahí. Así no se puede despegar de lo que muestra Wallet.
   * Lo único que sigue siendo una aproximación es el dibujo del código de barras (Wallet lo genera él mismo).
   */
  function renderPreviewFields() {
    const pass = buildPassJson({ passTypeId: '', teamId: '', orgName: '' }, state.fields, 'preview');
    const sc = pass.storeCard;
    $('pass').style.setProperty('--pass-bg', pass.backgroundColor);
    $('pass').style.setProperty('--pass-ink', pass.foregroundColor);
    $('pass').style.setProperty('--pass-label', pass.labelColor);
    $('pass').style.setProperty('--pass-accent', COLORS.accent);
    $('pv_logoText').textContent = pass.logoText;

    fillFieldRow($('pv_header'), sc.headerFields, 'hfield');
    fillFieldRow($('pv_fields'), frontRowFields(pass), 'fld');

    $('pv_back').innerHTML = '';
    for (const b of sc.backFields) {
      const row = document.createElement('div');
      row.className = 'bf';
      const lab = document.createElement('div'); lab.className = 'l'; lab.textContent = b.label;
      const val = document.createElement('div'); val.className = 'v';
      // Wallet muestra los enlaces del dorso; en la vista previa los mostramos igual, pero armados a mano.
      const link = /<a href="([^"]+)">([^<]+)<\/a>/.exec(b.attributedValue || '');
      if (link) { const a = document.createElement('a'); a.href = link[1]; a.rel = 'noopener'; a.textContent = link[2]; val.append(a); }
      else { val.textContent = b.value; }
      row.append(lab, val);
      $('pv_back').append(row);
    }

    const code = pass.barcodes[0];
    $('pv_raw').textContent = code.message;
    $('pv_altText').textContent = code.altText || '';
    $('pv_codeFormat').textContent = code.format === 'PKBarcodeFormatPDF417' ? 'PDF417' : 'QR';
  }

  function fillFieldRow(host, fields, cls) {
    host.innerHTML = '';
    for (const f of fields) {
      const el = document.createElement('div');
      el.className = cls;
      const lab = document.createElement('div'); lab.className = 'l'; lab.textContent = f.label;
      const val = document.createElement('div'); val.className = 'v'; val.textContent = f.value;
      el.append(lab, val);
      host.append(el);
    }
  }

  /** Enumeración en castellano: "apellido, nombres y DNI". */
  const listEs = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`);

  /** Qué dice el botón: mientras no se puede tocar, explica qué falta o qué está haciendo. */
  function ctaState() {
    const f = state.fields;
    if (state.building) return { text: 'Armando el pase…', busy: true };
    if (state.scanning) return { text: 'Leyendo el código…', busy: true };
    if (!state.front) return { text: 'Falta la foto del frente' };
    if (!state.frontOnly && !state.back) return { text: 'Falta la foto del dorso' };
    const missing = [['apellido', 'apellido'], ['nombres', 'nombres'], ['dni', 'DNI']]
      .filter(([k]) => !f[k]).map(([, label]) => label);
    if (missing.length) return { text: `Completá ${listEs(missing)}` };
    return { text: 'Agregar a Apple Wallet', ready: true };
  }

  function updateCta() {
    const st = ctaState();
    const btn = $('addBtn');
    btn.disabled = !st.ready;
    btn.classList.toggle('busy', Boolean(st.busy));
    $('addBtnText').textContent = st.text;
  }

  /**
   * Con "solo el frente" los controles del dorso se esconden: no hace falta la foto.
   * Vuelven a aparecer si el código no apareció en el frente, porque en los DNI viejos está atrás.
   */
  /**
   * Lo único que el CSS no puede saber: que el frente no traía código y entonces el dorso vuelve a hacer falta.
   * El resto (qué se ve con "Solo el frente" tildado) lo resuelve el propio checkbox en la hoja de estilos,
   * así no hay parpadeo al cargar ni estados que se puedan desincronizar.
   */
  function updateBackStep() {
    $('step-back').classList.toggle('needs-back', Boolean(state.front && !state.scanned));
  }

  /** Modo "solo el frente": el dorso no entra en la imagen del pase. */
  function setFrontOnly(on) {
    state.frontOnly = on;
    updateBackStep();
    renderPreviewStrip();
    updateCta();
  }

  // ---------- Cámara en vivo con marco guía ----------
  // El video se muestra "cover" a pantalla completa; el marco guía tiene la proporción de media mitad del strip.
  // Al disparar, se recorta del frame de video exactamente el área del marco → misma imagen que va al pase.
  const cam = { stream: null, which: null };

  async function openCamera(which) {
    if (!navigator.mediaDevices?.getUserMedia) { $(which + 'File').click(); return; }
    cam.which = which;
    try {
      cam.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 2160 } },
        audio: false,
      });
    } catch (e) {
      setStatus($(which + 'Status'), 'No se pudo abrir la cámara (' + (e?.name || e) + '). Elegí una foto de la galería.', 'warn');
      $(which + 'File').click();
      return;
    }
    const v = $('camVideo');
    v.srcObject = cam.stream;
    $('cam').hidden = false;
    document.body.classList.add('cam-open');
    try { await v.play(); } catch { /* autoplay ya lo hace */ }
  }

  function closeCamera() {
    cam.stream?.getTracks().forEach((t) => t.stop());
    cam.stream = null;
    $('camVideo').srcObject = null;
    $('cam').hidden = true;
    document.body.classList.remove('cam-open');
  }

  /** Recorta del frame de video el rectángulo del marco guía (en px del video) y lo manda al flujo normal de foto. */
  function shoot() {
    const v = $('camVideo');
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return;
    const vr = v.getBoundingClientRect(), gr = $('camGuide').getBoundingClientRect();
    const s = Math.max(vr.width / vw, vr.height / vh); // px CSS por px de video (object-fit: cover)
    const offX = vr.left + (vr.width - vw * s) / 2, offY = vr.top + (vr.height - vh * s) / 2;
    const sx = clamp((gr.left - offX) / s, 0, vw), sy = clamp((gr.top - offY) / s, 0, vh);
    const sw = Math.min(gr.width / s, vw - sx), sh = Math.min(gr.height / s, vh - sy);
    const c = document.createElement('canvas');
    c.width = Math.round(sw); c.height = Math.round(sh);
    c.getContext('2d').drawImage(v, sx, sy, sw, sh, 0, 0, c.width, c.height);
    const which = cam.which;
    closeCamera();
    c.toBlob((b) => onPhoto(which, new File([b], which + '.jpg', { type: 'image/jpeg' })), 'image/jpeg', 0.95);
  }

  async function onPhoto(which, file) {
    if (!file) return;
    setStatus($(which + 'Status'), '', '');
    const img = await loadImage(file);
    if (state[which]) URL.revokeObjectURL(state[which].img.src);
    state[which] = { img, zoom: 1, cx: 0.5, cy: 0.5 };
    $(which + 'Canvas').hidden = false; // el CSS se entera solo: .capture:has(canvas:not([hidden]))
    $(which + 'Cta').textContent = 'Volver a sacar'; // el icono lo cambia el CSS al ver el canvas
    renderFrame(which);
    renderPreviewStrip();
    updateCta();
    await scanSide(which, img);
  }

  /**
   * Busca el PDF417 en la foto recién tomada, sea cual sea la cara: en los DNI 2012+ el código suele estar
   * en el frente y en los 2009-2012 en el dorso, así que probamos las dos y nos quedamos con la primera lectura.
   * Se decodifica la foto completa, no el recorte del marco.
   */
  async function scanSide(which, img) {
    const st = $(which + 'Status');
    if (state.scanned) { setStatus(st, '', ''); return; }
    setStatus(st, 'Buscando el código PDF417…', 'busy');
    state.scanning = true;
    updateCta();
    const text = await decodePdf417(img);
    state.scanning = false;
    const parsed = text && parseDni(text);
    if (parsed) {
      state.scanned = true;
      fillForm(parsed);
      setStatus(st, 'Código leído. Revisá los datos abajo.', 'ok');
      const other = which === 'front' ? 'back' : 'front';
      setStatus($(other + 'Status'), '', '');
    } else if (state.front && state.back) {
      setStatus(st, 'No se pudo leer el código en ninguna de las dos caras. Probá con más luz, el DNI bien plano, o completá los datos a mano.', 'warn');
    } else {
      setStatus(st, 'No se encontró el código en esta cara. Puede estar en la otra: seguí con la siguiente foto.', '');
    }
    updateBackStep();
    updateCta(); // sin esto el botón queda en "Leyendo el código…" cuando la lectura falla
  }

  // Al tocar "Agregar": armo strips + campos y hago un POST de nivel superior.
  // Safari abre la hoja "Agregar a Wallet" al recibir application/vnd.apple.pkpass.
  // ---------- Armar el pase en el teléfono ----------
  // El pase se arma acá y al servidor solo se le manda el manifest, que son hashes: la foto no sale del teléfono.
  // Si algo de este camino falla, queda el de antes (POST de la imagen a /api/pass).
  const PASS_ASSETS = Object.fromEntries(Object.entries(PASS_ASSETS_B64).map(([k, v]) => [k, fromBase64(v)]));

  const canvasBytes = (canvas) => new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b.arrayBuffer().then((a) => new Uint8Array(a))) : reject(new Error('canvas vacío'))), 'image/png');
  });

  async function buildPassLocally() {
    const [s1, s2, s3] = await Promise.all([canvasBytes(composeStrip(1)), canvasBytes(composeStrip(2)), canvasBytes(composeStrip(3))]);
    const images = { 'strip.png': s1, 'strip@2x.png': s2, 'strip@3x.png': s3 };
    // Al servidor van los campos y el sha1 de cada imagen. La foto no: de ella solo viaja el hash.
    const strips = Object.fromEntries(await Promise.all(Object.entries(images).map(async ([n, b]) => [n, await sha1hex(b)])));
    const res = await fetch('api/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: state.fields, strips }),
    });
    if (!res.ok) throw new Error(`firma: ${res.status} ${await res.text()}`);
    const out = await res.json();
    // El pass.json lo arma el servidor (así nadie puede hacerle firmar un pase inventado): usamos sus bytes tal cual.
    const files = {
      ...PASS_ASSETS,
      ...images,
      'pass.json': utf8(out.passJson),
      'manifest.json': utf8(out.manifest),
      'signature': fromBase64(out.signature),
    };
    const manifest = JSON.parse(out.manifest);
    for (const [name, hash] of Object.entries(strips)) {
      if (manifest[name] !== hash) throw new Error('el manifest firmado no coincide con nuestras imágenes');
    }
    return { bytes: zipStore(files), serial: out.serial };
  }

  /**
   * Wallet se abre de forma confiable cuando la respuesta llega por red con el Content-Type correcto.
   * El service worker responde esa navegación con los bytes que armamos acá, sin salir del teléfono.
   */
  async function deliverToWallet(bytes, serial) {
    const sw = navigator.serviceWorker?.controller;
    if (!sw) throw new Error('sin service worker');
    const path = `${location.pathname.replace(/[^/]*$/, '')}pkpass/${serial}.pkpass`;
    await new Promise((resolve, reject) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => (e.data?.ok ? resolve() : reject(new Error('el service worker no aceptó el pase')));
      setTimeout(() => reject(new Error('el service worker no respondió')), 3000);
      sw.postMessage({ type: 'pkpass', path, bytes }, [ch.port2]);
    });
    location.href = path;
  }

  /** Camino de respaldo: sube la imagen y el servidor arma y firma. */
  function submitViaServer() {
    $('pf_fields').value = JSON.stringify(state.fields);
    $('pf_strip1x').value = composeStrip(1).toDataURL('image/png');
    $('pf_strip2x').value = composeStrip(2).toDataURL('image/png');
    $('pf_strip3x').value = composeStrip(3).toDataURL('image/png');
    $('passForm').submit();
  }

  async function submitPass() {
    readForm();
    setStatus($('buildStatus'), '', '');
    state.building = true;
    updateCta();
    try {
      const { bytes, serial } = await buildPassLocally();
      await deliverToWallet(bytes, serial);
    } catch (e) {
      // Cualquier tropiezo del camino local cae al de siempre, que ya sabemos que funciona.
      console.warn('[pase] armado local falló, uso el servidor:', e?.message || e);
      try {
        submitViaServer();
      } catch (e2) {
        state.building = false;
        updateCta();
        setStatus($('buildStatus'), 'No se pudo armar el pase: ' + (e2?.message || e2), 'bad');
        return;
      }
    }
    // El POST de nivel superior no vuelve al JS: soltamos el botón cuando Wallet ya tuvo tiempo de abrirse.
    setTimeout(() => { state.building = false; updateCta(); }, 4000);
  }

  // ---------- Wiring ----------
  for (const which of ['front', 'back']) {
    $(which + 'File').addEventListener('change', (e) => onPhoto(which, e.target.files[0]));
    $(which + 'Cta').addEventListener('click', () => openCamera(which));
    // Sin foto, tocar el marco vacío también abre la cámara. Con foto, el marco es para encuadrar.
    $(which + 'Capture').addEventListener('click', (e) => {
      if (!state[which] && !e.target.closest('button, label')) openCamera(which);
    });
    wireGestures(which);
  }
  $('frontOnly').addEventListener('change', (e) => setFrontOnly(e.target.checked));
  $('flipBtn').addEventListener('click', () => {
    const showBack = $('passBack').hidden;
    $('passBack').hidden = !showBack;
    $('passFront').hidden = showBack;
    $('flipBtn').setAttribute('aria-pressed', String(showBack));
    $('flipBtn').setAttribute('aria-label', showBack ? 'Ver el frente del pase' : 'Ver el dorso del pase');
  });
  // iOS ignora user-scalable en Safari, así que además frenamos el gesto de zoom de la página.
  // El pellizco dentro del marco de encuadre sigue funcionando: ese canvas maneja sus propios punteros.
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  }

  // ---------- Tirar para actualizar ----------
  // En modo pantalla de inicio no hay barra del navegador ni gesto nativo: sin esto no se puede recargar
  // la página (ni soltar los datos de la sesión anterior, ni tomar una versión nueva de la app).
  (() => {
    const bar = $('ptr'), txt = $('ptrTxt');
    const MAX = 90, TRIGGER = 64;
    let startY = null, pull = 0;

    const move = (y) => {
      pull = Math.min(MAX, y);
      bar.style.transform = `translateY(${pull}px)`;
      bar.classList.toggle('ready', pull >= TRIGGER);
      txt.textContent = pull >= TRIGGER ? 'Soltá para actualizar' : 'Tirá para actualizar';
    };
    const reset = () => { bar.style.transition = 'transform .2s'; bar.style.transform = ''; bar.classList.remove('ready'); setTimeout(() => { bar.style.transition = ''; }, 220); };

    document.addEventListener('touchstart', (e) => {
      // Solo desde arriba de todo, con un dedo, y nunca sobre el encuadre o la cámara.
      if (e.touches.length !== 1 || window.scrollY > 0 || document.body.classList.contains('cam-open')) { startY = null; return; }
      if (e.target.closest('.capture, .cam')) { startY = null; return; }
      startY = e.touches[0].clientY; pull = 0;
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      if (startY === null) return;
      const dy = e.touches[0].clientY - startY;
      if (dy <= 0 || window.scrollY > 0) { if (pull) { reset(); } startY = null; return; }
      move(dy * 0.5); // resistencia, como el gesto nativo
    }, { passive: true });

    document.addEventListener('touchend', () => {
      if (startY === null) return;
      const go = pull >= TRIGGER;
      startY = null;
      if (!go) { reset(); return; }
      bar.classList.add('spin');
      txt.textContent = 'Actualizando…';
      location.reload();
    });
  })();

  $('camShot').addEventListener('click', shoot);
  $('camCancel').addEventListener('click', closeCamera);
  $('camPick').addEventListener('click', () => { const w = cam.which; closeCamera(); $(w + 'File').click(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('cam').hidden) closeCamera(); });
  window.addEventListener('resize', () => { for (const w of ['front', 'back']) if (state[w]) scheduleRender(w); });
  for (const id of dateIds) wireDateField($('f_' + id));
  // El DNI es solo números; apellido, nombres y ejemplar van en mayúsculas como en el documento.
  $('f_dni').addEventListener('input', (e) => { const el = e.target; const c = el.selectionStart; const v = el.value.replace(/\D/g, ''); if (v !== el.value) { el.value = v; try { el.setSelectionRange(c - 1, c - 1); } catch { /* ignorar */ } } });
  for (const id of ['apellido', 'nombres', 'ejemplar']) {
    $('f_' + id).addEventListener('blur', (e) => { const v = e.target.value.trim().toUpperCase(); if (v !== e.target.value) { e.target.value = v; readForm(); } });
  }
  $('f_cuil').addEventListener('input', () => { state.cuilTouched = true; state.cuilAuto = false; setFieldMsg($('f_cuil'), ''); });
  $('f_nacionalidad').addEventListener('input', () => { state.nacTouched = true; setFieldMsg($('f_nacionalidad'), ''); });
  $('f_vencimiento').addEventListener('input', () => { state.vencTouched = true; });
  $('dataForm').addEventListener('input', readForm);
  $('f_raw').addEventListener('change', () => { const p = parseDni($('f_raw').value); if (p) { state.scanned = true; fillForm(p); } });
  $('addBtn').addEventListener('click', submitPass);

  setFrontOnly($('frontOnly').checked);
  renderPreviewStrip();
  renderPreviewFields();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
