/* DNI en Wallet — frontend en JS puro.
 * Flujo: foto frente → foto dorso (decodifica PDF417) → revisar datos → strip (frente|dorso) → POST → .pkpass
 * Todo el procesamiento de imagen ocurre en el teléfono. Al servidor solo viaja el pase ya armado para firmarse.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // ---------- Estado ----------
  const state = {
    front: null,   // HTMLImageElement
    back: null,    // HTMLImageElement
    fields: { apellido: '', nombres: '', dni: '', sexo: '', nacimiento: '', ejemplar: '', tramite: '', emision: '', raw: '' },
  };

  // Dimensiones del strip para storeCard (375×123 pt) en 1x / 2x / 3x
  const STRIP = { w: 375, h: 123 };

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

  /** Dibuja `img` en el rect (x,y,w,h) del contexto con "cover" (recorte centrado). */
  function drawCover(ctx, img, x, y, w, h) {
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const s = Math.max(w / iw, h / ih);
    const dw = iw * s, dh = ih * s;
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }

  /** Compone frente | dorso lado a lado en un canvas de `scale`x. */
  function composeStrip(scale) {
    const c = document.createElement('canvas');
    c.width = STRIP.w * scale; c.height = STRIP.h * scale;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#0b1a2b';
    ctx.fillRect(0, 0, c.width, c.height);
    const gap = Math.round(3 * scale);
    const half = (c.width - gap) / 2;
    if (state.front) drawCover(ctx, state.front, 0, 0, half, c.height);
    if (state.back) drawCover(ctx, state.back, half + gap, 0, half, c.height);
    return c;
  }

  function renderPreviewStrip() {
    const target = $('stripCanvas');
    const src = composeStrip(3);
    target.width = src.width; target.height = src.height;
    target.getContext('2d').drawImage(src, 0, 0);
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

  /** Reintenta a varias escalas y rotaciones — las fotos de celular rara vez salen perfectas. */
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
    state[which] = img;
    const prev = $(which + 'Preview');
    prev.src = img.src; prev.hidden = false;
    prev.parentElement.classList.add('has-img');
    $(which + 'Cta').textContent = '↻ Volver a sacar';
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
  $('frontFile').addEventListener('change', (e) => onPhoto('front', e.target.files[0]));
  $('backFile').addEventListener('change', (e) => onPhoto('back', e.target.files[0]));
  $('dataForm').addEventListener('input', readForm);
  $('f_raw').addEventListener('change', () => { const p = parseDni($('f_raw').value); if (p) fillForm(p); });
  $('addBtn').addEventListener('click', submitPass);

  renderPreviewStrip();
  renderPreviewFields();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
