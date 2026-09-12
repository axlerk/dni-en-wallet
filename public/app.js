/* DNI en Wallet — frontend en JS puro.
 * Flujo: foto frente → foto dorso (el PDF417 se busca en las dos caras) → encuadre (arrastrar / pellizcar) → revisar datos → strip (frente|dorso) → POST → .pkpass
 * Todo el procesamiento de imagen ocurre en el teléfono. Al servidor solo viaja el pase ya armado para firmarse.
 */
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
    frontOnly: false, // armar el pase solo con el frente
    scanned: false,   // ya se leyó el PDF417 en alguna de las dos caras
    fields: { apellido: '', nombres: '', dni: '', sexo: '', nacimiento: '', ejemplar: '', tramite: '', emision: '', vencimiento: '', nacionalidad: '', cuil: '', raw: '' },
  };

  // Strip de storeCard: 375×123 pt en 1x/2x/3x.
  // El recorte de cada cara mantiene la proporción real de la tarjeta (ID-1, 85.6×54 mm), así no se corta nada:
  // dos caras entran como 186×117 con una franja de 3 pt arriba y abajo; solo el frente entra como 195×123 centrado.
  // Las franjas se pintan del color de fondo del pase, así que no se ven.
  const STRIP = { w: 375, h: 123, gap: 3, bg: '#163d66' };
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

  /** Dibuja el recorte de `side` en el rect (x,y,w,h) del contexto. */
  function drawCrop(ctx, side, x, y, w, h) {
    const r = cropRect(side, w, h);
    ctx.drawImage(side.img, r.sx, r.sy, r.vw, r.vh, x, y, w, h);
  }

  /** Rectángulo de proporción `ratio` centrado dentro de (x, y, w, h), sin recortar. */
  function fitRect(x, y, w, h, ratio) {
    const rw = Math.min(w, h * ratio), rh = rw / ratio;
    return { x: x + (w - rw) / 2, y: y + (h - rh) / 2, w: rw, h: rh };
  }

  /** True si el pase se arma solo con el frente (por elección o porque todavía no hay dorso). */
  const onlyFront = () => state.frontOnly || !state.back;

  /** Compone el strip: frente | dorso, o solo el frente centrado. */
  function composeStrip(scale) {
    const c = document.createElement('canvas');
    c.width = STRIP.w * scale; c.height = STRIP.h * scale;
    const ctx = c.getContext('2d');
    ctx.fillStyle = STRIP.bg;
    ctx.fillRect(0, 0, c.width, c.height);
    const draw = (side, slot) => {
      if (!side) return;
      const r = fitRect(slot.x, 0, slot.w, c.height, CARD_RATIO);
      drawCrop(ctx, side, r.x, r.y, r.w, r.h);
    };
    if (onlyFront()) {
      draw(state.front, { x: 0, w: c.width });
    } else {
      const gap = Math.round(STRIP.gap * scale);
      const half = (c.width - gap) / 2;
      draw(state.front, { x: 0, w: half });
      draw(state.back, { x: half + gap, w: half });
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
  function cuilFrom(tail, dni) {
    const t = String(tail || '').trim(), n = String(dni || '').padStart(8, '0');
    if (!/^\d{3}$/.test(t) || !/^\d{8}$/.test(n)) return '';
    const pre = t.slice(0, 2), dv = Number(t[2]);
    if (!['20', '23', '24', '27', '30', '33', '34'].includes(pre)) return '';
    const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
    const sum = (pre + n).split('').reduce((a, d, i) => a + Number(d) * w[i], 0);
    const r = sum % 11;
    if (r > 1 && 11 - r !== dv) return ''; // con resto 0 o 1 hay casos especiales: aceptamos lo que diga el código
    return `${pre}-${n}-${dv}`;
  }
  const onlyLetter = (s) => (/^[A-Za-z]$/.test(String(s || '').trim()) ? String(s).trim().toUpperCase() : '');
  const onlyDigits = (s) => String(s || '').replace(/\D/g, '');

  function parseDni(raw) {
    const t = String(raw || '').trim();
    if (!t.includes('@')) return null;
    const p = t.split('@').map((s) => s.trim());
    // El formato viejo tiene muchos más campos; el nuevo son 9 (a veces 8 sin CUIL).
    const f = p.length >= 14
      ? { dni: onlyDigits(p[1]), ejemplar: onlyLetter(p[2]), apellido: p[4], nombres: p[5], nacionalidad: p[6] || '', nacimiento: p[7], sexo: onlyLetter(p[8]), emision: p[9], vencimiento: isDate(p[12]) ? p[12] : '', tramite: '', cuil: '' }
      : p.length >= 8
        ? { tramite: onlyDigits(p[0]), apellido: p[1], nombres: p[2], sexo: onlyLetter(p[3]), dni: onlyDigits(p[4]), ejemplar: onlyLetter(p[5]), nacimiento: p[6], emision: p[7], vencimiento: '', nacionalidad: '', cuil: cuilFrom(p[8], onlyDigits(p[4])) }
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

  async function decodeWithZXing(canvas) {
    if (!window.ZXing?.BrowserPDF417Reader) return null;
    const reader = new window.ZXing.BrowserPDF417Reader();
    try {
      const res = await reader.decodeFromImageUrl(canvas.toDataURL('image/png'));
      return res?.getText?.() || null;
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
        const ctx = c.getContext('2d');
        ctx.translate(c.width / 2, c.height / 2);
        ctx.rotate((rot * Math.PI) / 180);
        ctx.drawImage(img, -w / 2, -h / 2, w, h);
        const text = (await decodeWithNative(c)) || (await decodeWithZXing(c));
        if (text) return text;
      }
    }
    return null;
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
    renderPreviewFields();
    updateCta();
  }

  function fmtDni(d) {
    const n = String(d || '').replace(/\D/g, '');
    return n ? n.replace(/\B(?=(\d{3})+(?!\d))/g, '.') : '—';
  }

  function renderPreviewFields() {
    const f = state.fields;
    $('pv_apellido').textContent = f.apellido || '—';
    $('pv_nombres').textContent = f.nombres || '—';
    $('pv_dni').textContent = fmtDni(f.dni);
    $('pv_nacimiento').textContent = f.nacimiento || '—';
    $('pv_sexo').textContent = f.sexo || '—';
    $('pv_ejemplar').textContent = f.ejemplar || '—';
    $('pv_raw').textContent = f.raw || 'Sin código — se usará un QR con los datos';
    renderPassBack();
  }

  // El dorso del pase: los mismos backFields que arma el servidor. En Wallet se ve tocando "•••".
  function renderPassBack() {
    const f = state.fields;
    const rows = [
      ['Aviso', 'Copia personal de referencia. No reemplaza al DNI físico ni al DNI Digital de Mi Argentina y no tiene validez legal.'],
      ['Nº de trámite', f.tramite],
      ['CUIL', f.cuil],
      ['Nacionalidad', f.nacionalidad],
      ['Fecha de emisión', f.emision],
      ['Fecha de vencimiento', f.vencimiento],
      ['Código PDF417', f.raw],
    ].filter(([, v]) => v);
    $('pv_back').innerHTML = '';
    for (const [l, v] of rows) {
      const row = document.createElement('div');
      row.className = 'bf';
      const lab = document.createElement('div'); lab.className = 'l'; lab.textContent = l.toUpperCase();
      const val = document.createElement('div'); val.className = 'v'; val.textContent = v;
      row.append(lab, val);
      $('pv_back').append(row);
    }
  }

  function updateCta() {
    const f = state.fields;
    const photos = state.front && (state.frontOnly || state.back);
    $('addBtn').disabled = !(photos && f.apellido && f.nombres && f.dni);
  }

  /** Modo "solo el frente": el dorso pasa a ser opcional y el strip muestra una sola cara. */
  function setFrontOnly(on) {
    state.frontOnly = on;
    $('step-back').classList.toggle('optional', on);
    $('backHint').hidden = !on;
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
    $(which + 'Canvas').hidden = false;
    $(which + 'Capture').classList.add('has-img');
    $(which + 'Cta').textContent = '↻ Volver a sacar';
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
    const text = await decodePdf417(img);
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
  }

  // Al tocar "Agregar": armo strips + campos y hago un POST de nivel superior.
  // Safari abre la hoja "Agregar a Wallet" al recibir application/vnd.apple.pkpass.
  function submitPass() {
    readForm();
    const st = $('buildStatus');
    setStatus(st, 'Armando el pase…', 'busy');
    try {
      $('pf_fields').value = JSON.stringify(state.fields);
      $('pf_strip1x').value = composeStrip(1).toDataURL('image/png');
      $('pf_strip2x').value = composeStrip(2).toDataURL('image/png');
      $('pf_strip3x').value = composeStrip(3).toDataURL('image/png');
      $('passForm').submit();
      setTimeout(() => setStatus(st, '', ''), 4000);
    } catch (e) {
      setStatus(st, 'No se pudo armar el pase: ' + (e?.message || e), 'bad');
    }
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
  $('camShot').addEventListener('click', shoot);
  $('camCancel').addEventListener('click', closeCamera);
  $('camPick').addEventListener('click', () => { const w = cam.which; closeCamera(); $(w + 'File').click(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('cam').hidden) closeCamera(); });
  window.addEventListener('resize', () => { for (const w of ['front', 'back']) if (state[w]) scheduleRender(w); });
  $('dataForm').addEventListener('input', readForm);
  $('f_raw').addEventListener('change', () => { const p = parseDni($('f_raw').value); if (p) { state.scanned = true; fillForm(p); } });
  $('addBtn').addEventListener('click', submitPass);

  renderPreviewStrip();
  renderPreviewFields();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
