/* DNI en Wallet — frontend en JS puro.
 * Flujo: foto frente → foto dorso (decodifica PDF417) → encuadre (arrastrar / pellizcar) → revisar datos → strip (frente|dorso) → POST → .pkpass
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
    fields: { apellido: '', nombres: '', dni: '', sexo: '', nacimiento: '', ejemplar: '', tramite: '', emision: '', raw: '' },
  };

  // Strip de storeCard: 375×123 pt en 1x/2x/3x. Cada lado ocupa una mitad menos el separador → 186×123.
  // El marco de captura tiene la misma proporción (CSS aspect-ratio), así lo que se ve en el marco es lo que va al pase.
  const STRIP = { w: 375, h: 123, gap: 3 };
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

  /** Compone frente | dorso lado a lado en un canvas de `scale`x. */
  function composeStrip(scale) {
    const c = document.createElement('canvas');
    c.width = STRIP.w * scale; c.height = STRIP.h * scale;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#0b1a2b';
    ctx.fillRect(0, 0, c.width, c.height);
    const gap = Math.round(STRIP.gap * scale);
    const half = (c.width - gap) / 2;
    if (state.front) drawCrop(ctx, state.front, 0, 0, half, c.height);
    if (state.back) drawCrop(ctx, state.back, half + gap, 0, half, c.height);
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
   * Formatos conocidos del código del dorso:
   *  - Nuevo (2012+):  tramite@apellido@nombres@sexo@dni@ejemplar@nacimiento@emision[@cuil@...]
   *  - Viejo (2009-12): @dni@ejemplar@?@apellido@nombres@nacionalidad@nacimiento@sexo@emision@...
   */
  function parseDni(raw) {
    const t = String(raw || '').trim();
    if (!t.includes('@')) return null;
    const p = t.split('@').map((s) => s.trim());
    if (t.startsWith('@')) {
      return { dni: p[1], ejemplar: p[2], apellido: p[4], nombres: p[5], nacimiento: p[7], sexo: p[8], emision: p[9], tramite: '', raw: t };
    }
    return { tramite: p[0], apellido: p[1], nombres: p[2], sexo: p[3], dni: p[4], ejemplar: p[5], nacimiento: p[6], emision: p[7], raw: t };
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
  const fieldIds = ['apellido', 'nombres', 'dni', 'sexo', 'nacimiento', 'ejemplar', 'tramite', 'emision', 'raw'];

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
  }

  function updateCta() {
    const f = state.fields;
    $('addBtn').disabled = !(state.front && state.back && f.apellido && f.nombres && f.dni);
  }

  async function onPhoto(which, file) {
    if (!file) return;
    const img = await loadImage(file);
    if (state[which]) URL.revokeObjectURL(state[which].img.src);
    state[which] = { img, zoom: 1, cx: 0.5, cy: 0.5 };
    $(which + 'Canvas').hidden = false;
    $(which + 'Capture').classList.add('has-img');
    $(which + 'Cta').textContent = '↻ Volver a sacar';
    renderFrame(which);
    renderPreviewStrip();
    updateCta();

    if (which === 'back') {
      const st = $('scanStatus');
      setStatus(st, 'Leyendo el código PDF417…', 'busy');
      const text = await decodePdf417(img);
      const parsed = text && parseDni(text);
      if (parsed) {
        fillForm(parsed);
        setStatus(st, 'Código leído. Revisá los datos abajo.', 'ok');
      } else {
        setStatus(st, 'No se pudo leer el código. Probá con más luz y el dorso bien plano, o completá los datos a mano.', 'warn');
      }
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
    // Sin foto, todo el marco abre la cámara. Con foto, el marco es para encuadrar y solo el botón vuelve a sacar.
    $(which + 'Capture').addEventListener('click', (e) => {
      if (!state[which] && !e.target.closest('label')) $(which + 'File').click();
    });
    wireGestures(which);
  }
  window.addEventListener('resize', () => { for (const w of ['front', 'back']) if (state[w]) scheduleRender(w); });
  $('dataForm').addEventListener('input', readForm);
  $('f_raw').addEventListener('change', () => { const p = parseDni($('f_raw').value); if (p) fillForm(p); });
  $('addBtn').addEventListener('click', submitPass);

  renderPreviewStrip();
  renderPreviewFields();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
