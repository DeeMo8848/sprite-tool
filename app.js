/* =====================================================================
 * 精灵图处理工具  —  app.js
 * 页面：① 裁剪  ② 拼接(静态图像 / GIF帧编辑)  ③④ 占位
 * ===================================================================*/
(function () {
'use strict';

/* ------------------------------------------------------------------ */
/*  基础工具                                                          */
/* ------------------------------------------------------------------ */
var $ = function (s, r) { return (r || document).querySelector(s); };
var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

var toastTimer = null;
function toast(msg, type) {
  var t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (type ? ' ' + type : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.className = ''; }, 2400);
}

function makeCanvas(w, h) {
  var c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}
function ctx2d(c) { return c.getContext('2d', { willReadFrequently: true }); }

function loadImage(blob) {
  return new Promise(function (res, rej) {
    var url = URL.createObjectURL(blob);
    var img = new Image();
    img.onload = function () { res({ img: img, url: url }); };
    img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('无法加载图片')); };
    img.src = url;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise(function (res, rej) {
    canvas.toBlob(function (b) { b ? res(b) : rej(new Error('导出失败')); }, type || 'image/png', quality);
  });
}
function downloadBlob(blob, name) {
  var a = document.createElement('a');
  var url = URL.createObjectURL(blob);
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 2000);
}
function baseName(n) { return String(n).replace(/\.[^.]+$/, ''); }
function blobBytes(blob) { return blob.arrayBuffer().then(function (ab) { return new Uint8Array(ab); }); }

/* ---- ZIP（store 模式，无压缩）---- */
var CRC_TABLE = (function () {
  var t = new Uint32Array(256);
  for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  var c = 0xFFFFFFFF;
  for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function createZip(files) { // files: [{name, data:Uint8Array}]
  var enc = new TextEncoder(), parts = [], central = [], offset = 0;
  files.forEach(function (f) {
    var nb = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
    var lh = new Uint8Array(30 + nb.length), dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true); dv.setUint16(6, 0x0800, true); dv.setUint16(8, 0, true);
    dv.setUint16(10, 0, true); dv.setUint16(12, 0, true);
    dv.setUint32(14, crc, true); dv.setUint32(18, size, true); dv.setUint32(22, size, true);
    dv.setUint16(26, nb.length, true); dv.setUint16(28, 0, true);
    lh.set(nb, 30);
    parts.push(lh, f.data);
    var cd = new Uint8Array(46 + nb.length), dv2 = new DataView(cd.buffer);
    dv2.setUint32(0, 0x02014b50, true);
    dv2.setUint16(4, 20, true); dv2.setUint16(6, 20, true); dv2.setUint16(8, 0x0800, true);
    dv2.setUint16(10, 0, true); dv2.setUint16(12, 0, true); dv2.setUint16(14, 0, true);
    dv2.setUint32(16, crc, true); dv2.setUint32(20, size, true); dv2.setUint32(24, size, true);
    dv2.setUint16(28, nb.length, true);
    dv2.setUint16(30, 0, true); dv2.setUint16(32, 0, true); dv2.setUint16(34, 0, true);
    dv2.setUint16(36, 0, true); dv2.setUint32(38, 0, true); dv2.setUint32(42, offset, true);
    cd.set(nb, 46);
    central.push(cd);
    offset += lh.length + size;
  });
  var cs = central.reduce(function (a, b) { return a + b.length; }, 0);
  var end = new Uint8Array(22), dv3 = new DataView(end.buffer);
  dv3.setUint32(0, 0x06054b50, true);
  dv3.setUint16(8, files.length, true); dv3.setUint16(10, files.length, true);
  dv3.setUint32(12, cs, true); dv3.setUint32(16, offset, true);
  return new Blob(parts.concat(central, [end]), { type: 'application/zip' });
}

/* ---- 棋盘格背景 ---- */
var checkerTile = null;
function getCheckerTile() {
  if (checkerTile) return checkerTile;
  var t = makeCanvas(16, 16), c = t.getContext('2d');
  c.fillStyle = '#20232f'; c.fillRect(0, 0, 16, 16);
  c.fillStyle = '#191c26'; c.fillRect(0, 0, 8, 8); c.fillRect(8, 8, 8, 8);
  checkerTile = t;
  return t;
}
function paintChecker(ctx, w, h) {
  var p = ctx.createPattern(getCheckerTile(), 'repeat');
  ctx.save(); ctx.fillStyle = p; ctx.fillRect(0, 0, w, h); ctx.restore();
}

/* ---- 文件选择 / 拖拽绑定 ---- */
function setupPicker(opts) {
  var zone = $(opts.zone), input = $(opts.input), btn = opts.btn ? $(opts.btn) : null;
  if (btn) btn.addEventListener('click', function (e) { e.stopPropagation(); input.click(); });
  zone.addEventListener('click', function (e) {
    if (e.target.closest('button') || e.target.closest('input') || e.target.closest('label')) return;
    input.click();
  });
  input.addEventListener('change', function () {
    if (input.files && input.files.length) opts.onFiles(input.files);
    input.value = '';
  });
  ['dragenter', 'dragover'].forEach(function (ev) {
    zone.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); zone.classList.add('over'); });
  });
  ['dragleave', 'dragend'].forEach(function (ev) {
    zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove('over'); });
  });
  zone.addEventListener('drop', function (e) {
    e.preventDefault(); e.stopPropagation(); zone.classList.remove('over');
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) opts.onFiles(e.dataTransfer.files);
  });
}

/* ---- 列表拖动排序 ---- */
function makeSortable(container, onMove) {
  var draggingId = null;
  container.addEventListener('dragstart', function (e) {
    var it = e.target.closest('[data-id]'); if (!it) return;
    draggingId = it.dataset.id; it.classList.add('dragging');
    try { e.dataTransfer.setData('text/plain', draggingId); e.dataTransfer.effectAllowed = 'move'; } catch (_) { }
  });
  container.addEventListener('dragend', function () {
    if (draggingId) { var d = container.querySelector('.dragging'); if (d) d.classList.remove('dragging'); draggingId = null; }
    $$('.drop-target', container).forEach(function (n) { n.classList.remove('drop-target'); });
  });
  container.addEventListener('dragover', function (e) {
    var it = e.target.closest('[data-id]'); if (!it || it.dataset.id === draggingId) return;
    e.preventDefault();
    $$('.drop-target', container).forEach(function (n) { n.classList.remove('drop-target'); });
    it.classList.add('drop-target');
  });
  container.addEventListener('drop', function (e) {
    e.preventDefault();
    var it = e.target.closest('[data-id]'); if (!it || !draggingId || it.dataset.id === draggingId) return;
    it.classList.remove('drop-target');
    onMove(draggingId, it.dataset.id);
    draggingId = null;
  });
}
function moveBefore(arr, fromId, toId) {
  var fi = -1, ti = -1;
  arr.forEach(function (it, i) { if (it.id === fromId) fi = i; if (it.id === toId) ti = i; });
  if (fi < 0 || ti < 0 || fi === ti) return false;
  var item = arr.splice(fi, 1)[0];
  ti = arr.findIndex(function (it) { return it.id === toId; });
  arr.splice(ti, 0, item);
  return true;
}

/* ---- 动画播放器 ---- */
function createAnim(canvas) {
  var a = { canvas: canvas, frames: [], durations: [], i: 0, timer: null, playing: false, onFrame: null };
  a.setFrames = function (frames, durations) {
    a.frames = frames || []; a.durations = durations || [];
    if (a.i >= a.frames.length) a.i = 0;
    a.draw();
  };
  a.draw = function () {
    var c = a.canvas.getContext('2d');
    if (!a.frames.length) { a.canvas.width = 10; a.canvas.height = 10; c.clearRect(0, 0, 10, 10); return; }
    var f = a.frames[a.i % a.frames.length];
    a.canvas.width = f.width; a.canvas.height = f.height;
    c = a.canvas.getContext('2d');
    c.imageSmoothingEnabled = false;
    c.clearRect(0, 0, a.canvas.width, a.canvas.height);
    c.drawImage(f, 0, 0);
    if (a.onFrame) a.onFrame((a.i % a.frames.length) + 1, a.frames.length);
  };
  function tick() {
    var d = a.durations[a.i % a.frames.length];
    if (d === undefined || d === null) d = 100;
    a.timer = setTimeout(function () {
      if (!a.playing) return;
      a.i = (a.i + 1) % a.frames.length;
      a.draw();
      tick();
    }, Math.max(16, d));
  }
  a.start = function () { if (a.playing || !a.frames.length) return; a.playing = true; tick(); };
  a.stop = function () { a.playing = false; clearTimeout(a.timer); };
  a.toggle = function () { a.playing ? a.stop() : a.start(); return a.playing; };
  a.step = function (delta) { a.stop(); if (!a.frames.length) return; var n = a.frames.length; a.i = ((a.i + delta) % n + n) % n; a.draw(); };
  return a;
}

/* ================================================================== */
/*  标签切换                                                           */
/* ================================================================== */
$$('.tab').forEach(function (btn) {
  btn.addEventListener('click', function () {
    $$('.tab').forEach(function (b) { b.classList.toggle('active', b === btn); });
    $$('.page').forEach(function (p) { p.classList.toggle('active', p.id === 'page-' + btn.dataset.tab); });
  });
});
$$('.subtab').forEach(function (btn) {
  btn.addEventListener('click', function () {
    $$('.subtab').forEach(function (b) { b.classList.toggle('active', b === btn); });
    var isStatic = btn.dataset.sub === 'static';
    $('#sub-static').hidden = !isStatic;
    $('#sub-gif').hidden = isStatic;
  });
});

/* ================================================================== */
/*  ① 裁剪工具                                                        */
/* ================================================================== */
var crop = { items: [], active: null, seq: 0, dirty: false };

function addCropFiles(fileList) {
  var files = Array.prototype.slice.call(fileList).filter(function (f) { return /^image\//.test(f.type) || /\.(png|jpe?g|webp|bmp|gif)$/i.test(f.name); });
  if (!files.length) { toast('没有可用的图片文件', 'err'); return; }
  Promise.all(files.map(function (f) {
    return loadImage(f).then(function (r) {
      return { id: 'c' + (crop.seq++), name: f.name, img: r.img, url: r.url, w: r.img.naturalWidth, h: r.img.naturalHeight, off: { l: 0, t: 0, r: 0, b: 0 }, auto: null, file: f };
    });
  })).then(function (list) {
    list.forEach(function (it) { crop.items.push(it); });
    computeAllAuto();
    if (!crop.active) selectCrop(crop.items[crop.items.length - list.length].id);
    renderCropList();
    toast('已添加 ' + list.length + ' 张图片', 'ok');
  }).catch(function (e) { toast(e.message, 'err'); });
}

function cropSettings() {
  return {
    mode: $('#crop-mode').value,
    alpha: parseInt($('#crop-alpha').value, 10),
    tol: parseInt($('#crop-tol').value, 10)
  };
}

function computeAuto(item) {
  if (!item.img.naturalWidth) { item.auto = null; return; }
  var w = item.w, h = item.h;
  var cv = makeCanvas(w, h), c = ctx2d(cv);
  c.clearRect(0, 0, w, h);
  c.drawImage(item.img, 0, 0);
  var d;
  try { d = c.getImageData(0, 0, w, h).data; } catch (e) { item.auto = null; return; }
  var st = cropSettings();
  var x0 = w, y0 = h, x1 = -1, y1 = -1, x, y;

  if (st.mode === 'alpha') {
    for (y = 0; y < h; y++) {
      var rowBase = y * w * 4;
      for (x = 0; x < w; x++) {
        if (d[rowBase + x * 4 + 3] >= st.alpha) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
  } else {
    var corners = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]].map(function (p) {
      var o = (p[1] * w + p[0]) * 4; return [d[o], d[o + 1], d[o + 2], d[o + 3]];
    });
    for (y = 0; y < h; y++) {
      var rb = y * w * 4;
      for (x = 0; x < w; x++) {
        var o2 = rb + x * 4;
        var r = d[o2], g = d[o2 + 1], b = d[o2 + 2], a = d[o2 + 3];
        var isBg = false;
        if (a < st.alpha) isBg = true;
        else {
          for (var ci = 0; ci < corners.length; ci++) {
            var cc = corners[ci];
            if (cc[3] < st.alpha) continue;
            if (Math.abs(r - cc[0]) + Math.abs(g - cc[1]) + Math.abs(b - cc[2]) <= st.tol) { isBg = true; break; }
          }
        }
        if (!isBg) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
  }
  item.auto = (x1 < 0) ? null : { x0: x0, y0: y0, x1: x1, y1: y1 };
}

function computeAllAuto() { crop.items.forEach(computeAuto); }

function finalRect(item) {
  if (!item || !item.auto) return null;
  var a = item.auto;
  var x0 = clamp(a.x0 - item.off.l, 0, item.w - 1);
  var y0 = clamp(a.y0 - item.off.t, 0, item.h - 1);
  var x1 = clamp(a.x1 + item.off.r, 0, item.w - 1);
  var y1 = clamp(a.y1 + item.off.b, 0, item.h - 1);
  if (x1 < x0 || y1 < y0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function activeCrop() { return crop.items.find(function (i) { return i.id === crop.active; }) || null; }

function selectCrop(id) {
  crop.active = id;
  var it = activeCrop();
  renderCropList();
  if (!it) { renderCropPreview(); return; }
  $('#crop-name').textContent = it.name;
  $('#crop-badge').textContent = it.w + '×' + it.h;
  $$('.off-num').forEach(function (inp) { inp.value = it.off[inp.dataset.off]; });
  renderCropPreview();
}

function renderCropList() {
  var list = $('#crop-list');
  list.innerHTML = '';
  if (!crop.items.length) { list.innerHTML = '<div class="list-empty">暂无图片</div>'; return; }
  crop.items.forEach(function (it) {
    var el = document.createElement('div');
    el.className = 'list-item' + (it.id === crop.active ? ' sel' : '');
    el.dataset.id = it.id;
    var img = document.createElement('img'); img.className = 'thumb'; img.src = it.url;
    var meta = document.createElement('div'); meta.className = 'li-meta';
    meta.innerHTML = '<div class="li-name">' + escapeHtml(it.name) + '</div><div class="li-sub">' + it.w + '×' + it.h + '</div>';
    var del = document.createElement('button'); del.className = 'mini danger li-del'; del.textContent = '✕'; del.title = '移除';
    del.addEventListener('click', function (e) {
      e.stopPropagation();
      var idx = crop.items.indexOf(it);
      if (idx >= 0) crop.items.splice(idx, 1);
      URL.revokeObjectURL(it.url);
      if (crop.active === it.id) crop.active = crop.items.length ? crop.items[Math.max(0, idx - 1)].id : null;
      if (crop.active) selectCrop(crop.active); else { renderCropList(); renderCropPreview(); $('#crop-name').textContent = '未选择图片'; $('#crop-badge').textContent = '—'; }
    });
    el.appendChild(img); el.appendChild(meta); el.appendChild(del);
    el.addEventListener('click', function () { selectCrop(it.id); });
    list.appendChild(el);
  });
}

function renderCropPreview() {
  var cv = $('#crop-canvas');
  var it = activeCrop();
  if (!it) {
    cv.width = 10; cv.height = 10;
    cv.getContext('2d').clearRect(0, 0, 10, 10);
    $('#crop-info').textContent = '—';
    return;
  }
  var pad = 16, maxW = 720, maxH = 460;
  var scale = Math.min((maxW - pad * 2) / it.w, (maxH - pad * 2) / it.h);
  scale = Math.min(scale, 8);
  var dw = Math.max(1, Math.round(it.w * scale)), dh = Math.max(1, Math.round(it.h * scale));
  cv.width = dw + pad * 2; cv.height = dh + pad * 2;
  var ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, cv.width, cv.height);
  paintChecker(ctx, cv.width, cv.height);
  ctx.drawImage(it.img, pad, pad, dw, dh);

  var rect = finalRect(it);
  if (rect) {
    var rx = pad + rect.x * scale, ry = pad + rect.y * scale, rw = rect.w * scale, rh = rect.h * scale;
    ctx.fillStyle = 'rgba(6,8,14,0.58)';
    ctx.fillRect(pad, pad, dw, ry - pad);
    ctx.fillRect(pad, ry + rh, dw, dh - (ry + rh) + pad);
    ctx.fillRect(pad, ry, rx - pad, rh);
    ctx.fillRect(rx + rw, ry, dw - (rx + rw) + pad, rh);

    if (it.auto) {
      var a = it.auto;
      ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(150,200,255,0.75)';
      ctx.strokeRect(pad + a.x0 * scale + .5, pad + a.y0 * scale + .5, (a.x1 - a.x0 + 1) * scale - 1, (a.y1 - a.y0 + 1) * scale - 1);
      ctx.setLineDash([]);
    }
    ctx.strokeStyle = '#39d0b0'; ctx.lineWidth = 2;
    ctx.strokeRect(rx + 1, ry + 1, Math.max(1, rw - 2), Math.max(1, rh - 2));

    $('#crop-info').textContent =
      '自动边界：x ' + (it.auto ? it.auto.x0 + '~' + it.auto.x1 : '无') + '  y ' + (it.auto ? it.auto.y0 + '~' + it.auto.y1 : '无') +
      '\n调整：左' + it.off.l + ' 上' + it.off.t + ' 右' + it.off.r + ' 下' + it.off.b +
      '\n最终裁剪区域：(' + rect.x + ', ' + rect.y + ')  尺寸 ' + rect.w + ' × ' + rect.h;
  } else {
    $('#crop-info').textContent = '未检测到有效内容（可切换检测方式 / 调整阈值）';
  }
}

function cropExportCanvas(it) {
  var rect = finalRect(it);
  if (!rect) return null;
  var cv = makeCanvas(rect.w, rect.h);
  cv.getContext('2d').drawImage(it.img, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
  return cv;
}

/* ---- 裁剪：事件 ---- */
setupPicker({ zone: '#crop-drop', input: '#crop-input', btn: '#crop-pick', onFiles: addCropFiles });

$('#crop-mode').addEventListener('change', function () { computeAllAuto(); renderCropPreview(); });
['#crop-alpha', '#crop-tol'].forEach(function (sel) {
  var inp = $(sel);
  inp.addEventListener('input', function () {
    $('#crop-alpha-val').textContent = $('#crop-alpha').value;
    $('#crop-tol-val').textContent = $('#crop-tol').value;
    computeAllAuto(); renderCropPreview();
  });
});
$$('.off-num').forEach(function (inp) {
  inp.addEventListener('input', function () {
    var it = activeCrop(); if (!it) return;
    var v = parseInt(inp.value, 10); if (isNaN(v)) v = 0;
    it.off[inp.dataset.off] = v;
    renderCropPreview();
  });
});
$$('.mini[data-off]').forEach(function (b) {
  b.addEventListener('click', function () {
    var it = activeCrop(); if (!it) return;
    var key = b.dataset.off, d = parseInt(b.dataset.d, 10);
    it.off[key] = (it.off[key] || 0) + d;
    $$('.off-num').forEach(function (inp) { if (inp.dataset.off === key) inp.value = it.off[key]; });
    renderCropPreview();
  });
});
$('#crop-redetect').addEventListener('click', function () { computeAllAuto(); renderCropPreview(); toast('已重新检测'); });
$('#crop-reset').addEventListener('click', function () {
  var it = activeCrop(); if (!it) return;
  it.off = { l: 0, t: 0, r: 0, b: 0 };
  $$('.off-num').forEach(function (inp) { inp.value = 0; });
  renderCropPreview(); toast('已重置调整');
});
$('#crop-export-one').addEventListener('click', function () {
  var it = activeCrop(); if (!it) { toast('请先选择图片', 'err'); return; }
  var cv = cropExportCanvas(it);
  if (!cv) { toast('没有可导出的区域', 'err'); return; }
  canvasToBlob(cv, 'image/png').then(function (b) { downloadBlob(b, baseName(it.name) + '_crop.png'); toast('已导出', 'ok'); });
});
$('#crop-export-all').addEventListener('click', function () {
  if (!crop.items.length) { toast('列表为空', 'err'); return; }
  var jobs = crop.items.map(function (it) {
    var cv = cropExportCanvas(it);
    if (!cv) return null;
    return canvasToBlob(cv, 'image/png').then(blobBytes).then(function (bytes) {
      return { name: baseName(it.name) + '_crop.png', data: bytes };
    });
  }).filter(Boolean);
  Promise.all(jobs).then(function (files) {
    if (!files.length) { toast('没有可导出的区域', 'err'); return; }
    downloadBlob(createZip(files), 'cropped_' + files.length + '.zip');
    toast('已导出 ' + files.length + ' 张 (ZIP)', 'ok');
  });
});
$('#crop-clear').addEventListener('click', function () {
  crop.items.forEach(function (it) { URL.revokeObjectURL(it.url); });
  crop.items = []; crop.active = null;
  renderCropList(); renderCropPreview();
  $('#crop-name').textContent = '未选择图片'; $('#crop-badge').textContent = '—';
});

/* ================================================================== */
/*  ② 拼接 — 静态图像                                                 */
/* ================================================================== */
var st = { items: [], seq: 0, framesTouched: false, gridMode: null, cells: [], cellW: 0, cellH: 0, rows: 1, cols: 1, sort: 'none' };
var stAnim = createAnim($('#st-anim'));

function addStFiles(fileList) {
  var files = Array.prototype.slice.call(fileList).filter(function (f) { return /^image\//.test(f.type) || /\.(png|jpe?g|webp|bmp|gif)$/i.test(f.name); });
  if (!files.length) { toast('没有可用的图片文件', 'err'); return; }
  Promise.all(files.map(function (f) {
    return loadImage(f).then(function (r) {
      return { id: 's' + (st.seq++), name: f.name, img: r.img, url: r.url, w: r.img.naturalWidth, h: r.img.naturalHeight };
    });
  })).then(function (list) {
    list.forEach(function (it) { st.items.push(it); });
    applySort();
    if (!st.framesTouched) $('#st-frames').value = st.items.length;
    renderStitch();
    toast('已添加 ' + list.length + ' 张图片', 'ok');
  }).catch(function (e) { toast(e.message, 'err'); });
}

function applySort() {
  var mode = $('#st-sort').value;
  st.sort = mode;
  if (mode === 'name-asc') st.items.sort(function (a, b) { return a.name.localeCompare(b.name); });
  else if (mode === 'name-desc') st.items.sort(function (a, b) { return b.name.localeCompare(a.name); });
  else if (mode === 'name-num') st.items.sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }); });
}

function stFramesOverride() {
  var v = parseInt($('#st-frames').value, 10);
  if (!st.framesTouched || isNaN(v) || v < 1) return null;
  return v;
}

function buildStaticCells() {
  var items = st.items;
  if (!items.length) return { cells: [], cellW: 0, cellH: 0 };
  var ov = stFramesOverride();
  var base = [];
  if (ov && ov !== items.length) {
    // 按帧数裁剪：把所有图横向拼成一条，再等分切成 ov 帧
    var totalW = items.reduce(function (a, it) { return a + it.w; }, 0);
    var maxH = Math.max.apply(null, items.map(function (it) { return it.h; }));
    var strip = makeCanvas(totalW, maxH), sc = strip.getContext('2d');
    var ox = 0;
    items.forEach(function (it) { sc.drawImage(it.img, ox, 0); ox += it.w; });
    for (var i = 0; i < ov; i++) {
      var a = Math.round(i * totalW / ov), b = Math.round((i + 1) * totalW / ov);
      var w = Math.max(1, b - a);
      var c = makeCanvas(w, maxH);
      c.getContext('2d').drawImage(strip, a, 0, w, maxH, 0, 0, w, maxH);
      base.push(c);
    }
  } else {
    var cw = Math.max.apply(null, items.map(function (it) { return it.w; }));
    var ch = Math.max.apply(null, items.map(function (it) { return it.h; }));
    items.forEach(function (it) {
      var c = makeCanvas(cw, ch);
      c.getContext('2d').drawImage(it.img, 0, 0);
      base.push(c);
    });
  }
  var cellW = Math.max.apply(null, base.map(function (c) { return c.width; }));
  var cellH = Math.max.apply(null, base.map(function (c) { return c.height; }));
  var cells = base;
  if ($('#st-mirror').checked) {
    var mir = base.map(function (c) {
      var m = makeCanvas(cellW, cellH), mc = m.getContext('2d');
      mc.translate(cellW, 0); mc.scale(-1, 1); mc.drawImage(c, 0, 0);
      return m;
    });
    cells = base.concat(mir);
  }
  return { cells: cells, cellW: cellW, cellH: cellH };
}

function computeGrid(total) {
  var rows = parseInt($('#st-rows').value, 10) || 1;
  var cols = parseInt($('#st-cols').value, 10) || 1;
  if (st.gridMode === 'rows') cols = Math.max(1, Math.ceil(total / rows));
  else if (st.gridMode === 'cols') rows = Math.max(1, Math.ceil(total / cols));
  else {
    rows = $('#st-mirror').checked ? 2 : 1;
    cols = Math.max(1, Math.ceil(total / rows));
  }
  if (total > 0) { $('#st-rows').value = rows; $('#st-cols').value = cols; }
  return { rows: rows, cols: cols };
}

function renderStitch() {
  var built = buildStaticCells();
  var cells = built.cells, cellW = built.cellW, cellH = built.cellH;
  var total = cells.length;
  var g = computeGrid(total);
  st.cells = cells; st.cellW = cellW; st.cellH = cellH; st.rows = g.rows; st.cols = g.cols;

  $('#st-w').value = cellW ? cellW : '—';
  $('#st-h').value = cellH ? cellH : '—';

  var cv = $('#st-sheet');
  if (!total) {
    cv.width = 10; cv.height = 10; cv.getContext('2d').clearRect(0, 0, 10, 10);
    $('#st-sheet-dim').textContent = '';
    stAnim.setFrames([]);
    $('#st-anim-info').textContent = '';
    renderStitchList();
    return;
  }
  cv.width = g.cols * cellW; cv.height = g.rows * cellH;
  var ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, cv.width, cv.height);
  cells.forEach(function (c, i) {
    var r = Math.floor(i / g.cols), col = i % g.cols;
    if (r >= g.rows) return;
    ctx.drawImage(c, col * cellW, r * cellH);
  });
  $('#st-sheet-dim').textContent = cv.width + '×' + cv.height + '　(' + g.rows + ' 行 × ' + g.cols + ' 列, 共 ' + total + ' 帧)';

  stAnim.setFrames(cells, cells.map(function () { return parseInt($('#st-delay').value, 10) || 100; }));
  stAnim.onFrame = function (i, n) { $('#st-anim-info').textContent = i + '/' + n; };
  renderStitchList();
}

function renderStitchList() {
  var list = $('#st-list');
  list.innerHTML = '';
  if (!st.items.length) { list.innerHTML = '<div class="list-empty">暂无图片</div>'; return; }
  st.items.forEach(function (it, i) {
    var el = document.createElement('div');
    el.className = 'list-item frame-item'; el.draggable = true; el.dataset.id = it.id;
    var idx = document.createElement('div'); idx.className = 'li-idx'; idx.textContent = (i + 1);
    var img = document.createElement('img'); img.className = 'thumb'; img.src = it.url; img.draggable = false;
    var meta = document.createElement('div'); meta.className = 'li-meta';
    meta.innerHTML = '<div class="li-name">' + escapeHtml(it.name) + '</div><div class="li-sub">' + it.w + '×' + it.h + '</div>';
    var btns = document.createElement('div'); btns.className = 'li-btns';
    btns.innerHTML = '<button class="mini" data-act="up" title="上移">↑</button><button class="mini" data-act="down" title="下移">↓</button><button class="mini danger" data-act="del" title="移除">✕</button>';
    el.appendChild(idx); el.appendChild(img); el.appendChild(meta); el.appendChild(btns);
    list.appendChild(el);
  });
}

$('#st-list').addEventListener('click', function (e) {
  var b = e.target.closest('button[data-act]'); if (!b) return;
  var el = b.closest('[data-id]'); var id = el.dataset.id;
  var i = st.items.findIndex(function (x) { return x.id === id; });
  if (i < 0) return;
  if (b.dataset.act === 'up' && i > 0) { var t = st.items[i - 1]; st.items[i - 1] = st.items[i]; st.items[i] = t; }
  else if (b.dataset.act === 'down' && i < st.items.length - 1) { var t2 = st.items[i + 1]; st.items[i + 1] = st.items[i]; st.items[i] = t2; }
  else if (b.dataset.act === 'del') { URL.revokeObjectURL(st.items[i].url); st.items.splice(i, 1); if (!st.framesTouched) $('#st-frames').value = st.items.length; }
  st.sort = 'none'; $('#st-sort').value = 'none';
  renderStitch();
});
makeSortable($('#st-list'), function (from, to) {
  if (moveBefore(st.items, from, to)) { st.sort = 'none'; $('#st-sort').value = 'none'; renderStitch(); }
});

setupPicker({ zone: '#st-drop', input: '#st-input', btn: '#st-pick', onFiles: addStFiles });

$('#st-frames').addEventListener('input', function () {
  st.framesTouched = $('#st-frames').value !== '';
  renderStitch();
});
$('#st-rows').addEventListener('input', function () { st.gridMode = 'rows'; renderStitch(); });
$('#st-cols').addEventListener('input', function () { st.gridMode = 'cols'; renderStitch(); });
$('#st-mirror').addEventListener('change', function () { st.gridMode = null; renderStitch(); });
$('#st-sort').addEventListener('change', function () { applySort(); renderStitch(); });
$('#st-refresh').addEventListener('click', function () { renderStitch(); toast('已刷新预览'); });
$('#st-delay').addEventListener('input', function () { renderStitch(); });
$('#st-play').addEventListener('click', function () {
  var on = stAnim.toggle();
  $('#st-play').textContent = on ? '❚❚' : '▶';
});
$('#st-prev').addEventListener('click', function () { stAnim.step(-1); $('#st-play').textContent = '▶'; });
$('#st-next').addEventListener('click', function () { stAnim.step(+1); $('#st-play').textContent = '▶'; });
$('#st-clear').addEventListener('click', function () {
  st.items.forEach(function (it) { URL.revokeObjectURL(it.url); });
  st.items = []; st.framesTouched = false; st.gridMode = null;
  $('#st-frames').value = ''; $('#st-rows').value = 1; $('#st-cols').value = 1; $('#st-mirror').checked = false;
  stAnim.stop(); $('#st-play').textContent = '▶';
  renderStitch();
});

function stSheetCanvas() {
  if (!st.cells.length) return null;
  var cv = makeCanvas(st.cols * st.cellW, st.rows * st.cellH), c = cv.getContext('2d');
  c.imageSmoothingEnabled = false;
  st.cells.forEach(function (cell, i) {
    var r = Math.floor(i / st.cols), col = i % st.cols;
    if (r >= st.rows) return;
    c.drawImage(cell, col * st.cellW, r * st.cellH);
  });
  return cv;
}
$('#st-export-png').addEventListener('click', function () {
  var cv = stSheetCanvas();
  if (!cv) { toast('请先添加图片', 'err'); return; }
  canvasToBlob(cv, 'image/png').then(function (b) { downloadBlob(b, 'sprite_sheet.png'); toast('已导出 PNG', 'ok'); });
});
$('#st-export-gif').addEventListener('click', function () {
  if (!st.cells.length) { toast('请先添加图片', 'err'); return; }
  var delay = parseInt($('#st-delay').value, 10); if (isNaN(delay)) delay = 100;
  var frames = st.cells.map(function (cell) {
    var cv = makeCanvas(st.cellW, st.cellH), c = ctx2d(cv);
    c.imageSmoothingEnabled = false;
    c.drawImage(cell, 0, 0);
    return { data: c.getImageData(0, 0, st.cellW, st.cellH).data, delay: delay };
  });
  try {
    var bytes = GifCodec.encodeGif(frames, st.cellW, st.cellH, { loop: 0 });
    downloadBlob(new Blob([bytes], { type: 'image/gif' }), 'sprite_sheet.gif');
    toast('已导出 GIF（' + frames.length + ' 帧）', 'ok');
  } catch (e) { toast('GIF 导出失败：' + e.message, 'err'); }
});

/* ================================================================== */
/*  ② 拼接 — GIF 帧编辑                                               */
/* ================================================================== */
var gf = { frames: [], seq: 0, w: 0, h: 0, gridMode: null, sel: null };
var gfAnim = createAnim($('#gif-anim'));

function loadGifFile(file) {
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function () {
    try {
      var dec = GifCodec.decodeGif(new Uint8Array(reader.result));
      gf.w = dec.width; gf.h = dec.height;
      gf.frames = dec.frames.map(function (f, i) {
        var cv = makeCanvas(dec.width, dec.height);
        ctx2d(cv).putImageData(new ImageData(new Uint8ClampedArray(f.data), dec.width, dec.height), 0, 0);
        return { id: 'g' + (gf.seq++), canvas: cv, delay: f.delay, name: baseName(file.name) + '_' + (i + 1) };
      });
      gf.gridMode = null; $('#gif-rows').value = 1; $('#gif-cols').value = 1; $('#gif-mirror').checked = false;
      renderGif();
      toast('已载入 GIF：' + gf.frames.length + ' 帧', 'ok');
    } catch (e) { toast('GIF 解析失败：' + e.message, 'err'); }
  };
  reader.onerror = function () { toast('文件读取失败', 'err'); };
  reader.readAsArrayBuffer(file);
}

function gifBuildCells() {
  var base = gf.frames.map(function (f) { return f.canvas; });
  var cells = base, cellW = gf.w, cellH = gf.h;
  if ($('#gif-mirror').checked && base.length) {
    var mir = base.map(function (c) {
      var m = makeCanvas(cellW, cellH), mc = m.getContext('2d');
      mc.translate(cellW, 0); mc.scale(-1, 1); mc.drawImage(c, 0, 0);
      return m;
    });
    cells = base.concat(mir);
  }
  return { cells: cells, cellW: cellW, cellH: cellH };
}

function gifComputeGrid(total) {
  var rows = parseInt($('#gif-rows').value, 10) || 1;
  var cols = parseInt($('#gif-cols').value, 10) || 1;
  if (gf.gridMode === 'rows') cols = Math.max(1, Math.ceil(total / rows));
  else if (gf.gridMode === 'cols') rows = Math.max(1, Math.ceil(total / cols));
  else { rows = $('#gif-mirror').checked ? 2 : 1; cols = Math.max(1, Math.ceil(total / rows)); }
  if (total > 0) { $('#gif-rows').value = rows; $('#gif-cols').value = cols; }
  return { rows: rows, cols: cols };
}

function renderGif() {
  $('#gif-w').value = gf.w ? gf.w : '—';
  $('#gif-h').value = gf.h ? gf.h : '—';
  $('#gif-count').value = gf.frames.length;

  var built = gifBuildCells();
  var cells = built.cells, cellW = built.cellW, cellH = built.cellH;
  var g = gifComputeGrid(cells.length);
  gf.cells = cells; gf.rows = g.rows; gf.cols = g.cols; gf.cellW = cellW; gf.cellH = cellH;

  var cv = $('#gif-sheet');
  if (!cells.length) {
    cv.width = 10; cv.height = 10; cv.getContext('2d').clearRect(0, 0, 10, 10);
    $('#gif-sheet-dim').textContent = '';
    gfAnim.setFrames([]); $('#gif-anim-info').textContent = '';
    renderGifList();
    return;
  }
  cv.width = g.cols * cellW; cv.height = g.rows * cellH;
  var c = cv.getContext('2d');
  c.imageSmoothingEnabled = false; c.clearRect(0, 0, cv.width, cv.height);
  cells.forEach(function (cell, i) {
    var r = Math.floor(i / g.cols), col = i % g.cols;
    if (r >= g.rows) return;
    c.drawImage(cell, col * cellW, r * cellH);
  });
  $('#gif-sheet-dim').textContent = cv.width + '×' + cv.height + '　(' + g.rows + ' 行 × ' + g.cols + ' 列, 共 ' + cells.length + ' 帧)';

  gfAnim.onFrame = function (i, n) { $('#gif-anim-info').textContent = i + '/' + n; };
  gfUpdateAnim();

  // 总时长提示
  var totalMs = gf.frames.reduce(function (a, f) { return a + (f.delay || 0); }, 0);
  $('#gif-anim-info').title = '总时长约 ' + totalMs + ' ms';
  renderGifList();
}

function gfUpdateAnim() {
  if (!gf.frames.length) { gfAnim.setFrames([]); return; }
  var durs = gf.frames.map(function (f) { return f.delay; });
  var frames = gf.frames.map(function (f) { return f.canvas; });
  if ($('#gif-mirror').checked) {
    var mir = gf.frames.map(function (f) {
      var m = makeCanvas(gf.w, gf.h), mc = m.getContext('2d');
      mc.translate(gf.w, 0); mc.scale(-1, 1); mc.drawImage(f.canvas, 0, 0);
      return m;
    });
    frames = frames.concat(mir);
    durs = durs.concat(durs);
  }
  gfAnim.setFrames(frames, durs);
}

function renderGifList() {
  var list = $('#gif-list');
  list.innerHTML = '';
  if (!gf.frames.length) { list.innerHTML = '<div class="list-empty">暂无 GIF</div>'; return; }
  gf.frames.forEach(function (f, i) {
    var el = document.createElement('div');
    el.className = 'list-item frame-item' + (f.id === gf.sel ? ' sel' : '');
    el.draggable = true; el.dataset.id = f.id;
    var idx = document.createElement('div'); idx.className = 'li-idx'; idx.textContent = (i + 1);
    var th = document.createElement('canvas');
    th.width = f.canvas.width; th.height = f.canvas.height;
    th.className = 'thumb';
    th.getContext('2d').drawImage(f.canvas, 0, 0);
    var meta = document.createElement('div'); meta.className = 'li-meta';
    meta.innerHTML = '<div class="li-sub">第 ' + (i + 1) + ' 帧</div>';
    var din = document.createElement('input');
    din.type = 'number'; din.className = 'delay-input'; din.min = '0'; din.step = '10';
    din.value = f.delay; din.title = '跳转到下一帧的时间 (ms)';
    din.addEventListener('click', function (e) { e.stopPropagation(); });
    din.addEventListener('input', function () {
      var v = parseInt(din.value, 10); if (isNaN(v) || v < 0) v = 0;
      f.delay = v;
      gfUpdateAnim();
    });
    var btns = document.createElement('div'); btns.className = 'li-btns';
    btns.innerHTML = '<button class="mini" data-act="up" title="上移">↑</button><button class="mini" data-act="down" title="下移">↓</button><button class="mini danger" data-act="del" title="删除帧">✕</button>';
    el.appendChild(idx); el.appendChild(th); el.appendChild(meta); el.appendChild(din); el.appendChild(btns);
    el.addEventListener('click', function () { gf.sel = f.id; renderGifList(); });
    list.appendChild(el);
  });
}

$('#gif-list').addEventListener('click', function (e) {
  var b = e.target.closest('button[data-act]'); if (!b) return;
  var id = b.closest('[data-id]').dataset.id;
  var i = gf.frames.findIndex(function (x) { return x.id === id; });
  if (i < 0) return;
  if (b.dataset.act === 'up' && i > 0) { var t = gf.frames[i - 1]; gf.frames[i - 1] = gf.frames[i]; gf.frames[i] = t; }
  else if (b.dataset.act === 'down' && i < gf.frames.length - 1) { var t2 = gf.frames[i + 1]; gf.frames[i + 1] = gf.frames[i]; gf.frames[i] = t2; }
  else if (b.dataset.act === 'del') gf.frames.splice(i, 1);
  renderGif();
});
makeSortable($('#gif-list'), function (from, to) { if (moveBefore(gf.frames, from, to)) renderGif(); });

setupPicker({ zone: '#gif-drop', input: '#gif-input', btn: '#gif-pick', onFiles: function (fl) { loadGifFile(fl[0]); } });

$('#gif-ins-file').addEventListener('click', function () { $('#gif-insert-input').click(); });
$('#gif-insert-input').addEventListener('change', function (e) {
  var files = Array.prototype.slice.call(e.target.files);
  e.target.value = '';
  if (!files.length) return;
  if (!gf.w || !gf.h) { toast('请先载入 GIF 以确定帧尺寸（或先插入作为首帧）', 'err'); return; }
  var at = 0;
  var idx = gf.frames.findIndex(function (f) { return f.id === gf.sel; });
  at = idx >= 0 ? idx + 1 : gf.frames.length;
  Promise.all(files.map(function (f) { return loadImage(f).then(function (r) { return { img: r.img, name: f.name }; }); }))
    .then(function (list) {
      list.forEach(function (o, k) {
        var cv = makeCanvas(gf.w, gf.h);
        cv.getContext('2d').drawImage(o.img, 0, 0);
        gf.frames.splice(at + k, 0, { id: 'g' + (gf.seq++), canvas: cv, delay: 100, name: o.name });
      });
      renderGif(); toast('已插入 ' + list.length + ' 帧', 'ok');
    });
});
$('#gif-rows').addEventListener('input', function () { gf.gridMode = 'rows'; renderGif(); });
$('#gif-cols').addEventListener('input', function () { gf.gridMode = 'cols'; renderGif(); });
$('#gif-mirror').addEventListener('change', function () { gf.gridMode = null; renderGif(); });
$('#gif-apply-all').addEventListener('click', function () {
  var v = parseInt($('#gif-delay-all').value, 10); if (isNaN(v) || v < 0) v = 0;
  gf.frames.forEach(function (f) { f.delay = v; });
  renderGif(); toast('已把全部帧延时设为 ' + v + ' ms', 'ok');
});
$('#gif-play').addEventListener('click', function () {
  var on = gfAnim.toggle();
  $('#gif-play').textContent = on ? '❚❚' : '▶';
});
$('#gif-prev').addEventListener('click', function () { gfAnim.step(-1); $('#gif-play').textContent = '▶'; });
$('#gif-next').addEventListener('click', function () { gfAnim.step(+1); $('#gif-play').textContent = '▶'; });
$('#gif-clear').addEventListener('click', function () {
  gf.frames = []; gf.w = 0; gf.h = 0; gf.sel = null; gf.gridMode = null;
  $('#gif-rows').value = 1; $('#gif-cols').value = 1; $('#gif-mirror').checked = false;
  gfAnim.stop(); $('#gif-play').textContent = '▶';
  renderGif();
});

$('#gif-export-png').addEventListener('click', function () {
  if (!gf.cells || !gf.cells.length) { toast('请先载入 GIF', 'err'); return; }
  var cv = makeCanvas(gf.cols * gf.cellW, gf.rows * gf.cellH);
  var c = cv.getContext('2d'); c.imageSmoothingEnabled = false;
  gf.cells.forEach(function (cell, i) {
    var r = Math.floor(i / gf.cols), col = i % gf.cols;
    if (r >= gf.rows) return;
    c.drawImage(cell, col * gf.cellW, r * gf.cellH);
  });
  canvasToBlob(cv, 'image/png').then(function (b) { downloadBlob(b, 'gif_sheet.png'); toast('已导出 PNG', 'ok'); });
});
$('#gif-export-gif').addEventListener('click', function () {
  if (!gf.frames.length) { toast('请先载入 GIF', 'err'); return; }
  var mirror = $('#gif-mirror').checked;
  var frames = [];
  gf.frames.forEach(function (f) {
    var cv = makeCanvas(gf.w, gf.h), c = ctx2d(cv);
    c.imageSmoothingEnabled = false;
    c.drawImage(f.canvas, 0, 0);
    frames.push({ data: c.getImageData(0, 0, gf.w, gf.h).data, delay: f.delay });
  });
  if (mirror) {
    gf.frames.forEach(function (f) {
      var cv = makeCanvas(gf.w, gf.h), c = ctx2d(cv);
      c.imageSmoothingEnabled = false;
      c.translate(gf.w, 0); c.scale(-1, 1); c.drawImage(f.canvas, 0, 0);
      frames.push({ data: c.getImageData(0, 0, gf.w, gf.h).data, delay: f.delay });
    });
  }
  try {
    var bytes = GifCodec.encodeGif(frames, gf.w, gf.h, { loop: 0 });
    downloadBlob(new Blob([bytes], { type: 'image/gif' }), 'edited.gif');
    toast('已导出 GIF（' + frames.length + ' 帧）', 'ok');
  } catch (e) { toast('GIF 导出失败：' + e.message, 'err'); }
});

/* ================================================================== */
/*  ③ 自动裁剪（按网格拆分精灵表）                                    */
/* ================================================================== */
var ac = { img: null, url: null, name: '', w: 0, h: 0, mode: 'cell', cells: [], cellW: 0, cellH: 0, rows: 1, cols: 1, sel: -1 };

function acInt(sel) { var v = parseInt($(sel).value, 10); return isNaN(v) ? 0 : v; }
function acPrefix() { var v = $('#ac-prefix').value.trim(); return v || (ac.name ? baseName(ac.name) : 'slice'); }

function addAcImage(fileList) {
  var files = Array.prototype.slice.call(fileList).filter(function (f) { return /^image\//.test(f.type) || /\.(png|jpe?g|webp|bmp|gif)$/i.test(f.name); });
  if (!files.length) { toast('没有可用的图片文件', 'err'); return; }
  loadImage(files[0]).then(function (r) {
    if (ac.url) URL.revokeObjectURL(ac.url);
    ac.img = r.img; ac.url = r.url; ac.w = r.img.naturalWidth; ac.h = r.img.naturalHeight; ac.name = files[0].name; ac.sel = -1;
    $('#ac-name').textContent = files[0].name;
    $('#ac-badge').textContent = ac.w + '×' + ac.h;
    acCompute(); renderAutoCrop();
    toast('已载入 ' + ac.w + '×' + ac.h + '，自动拆分 ' + ac.cells.length + ' 帧', 'ok');
  }).catch(function (e) { toast(e.message, 'err'); });
}

function acCompute() {
  var img = ac.img; ac.cells = [];
  if (!img) return;
  var offx = Math.max(0, acInt('#ac-offx')), offy = Math.max(0, acInt('#ac-offy'));
  var gx = Math.max(0, acInt('#ac-gapx')), gy = Math.max(0, acInt('#ac-gapy'));
  var cellW, cellH, rows, cols;
  if (ac.mode === 'cell') {
    cellW = acInt('#ac-cw'); cellH = acInt('#ac-ch');
    if (cellW < 1 || cellH < 1) { ac.cellW = 0; ac.cellH = 0; ac.rows = 0; ac.cols = 0; return; }
    cols = Math.max(1, Math.floor((ac.w - offx) / (cellW + gx)));
    rows = Math.max(1, Math.floor((ac.h - offy) / (cellH + gy)));
  } else {
    rows = acInt('#ac-rows'); cols = acInt('#ac-cols');
    if (rows < 1 || cols < 1) { ac.cellW = 0; ac.cellH = 0; ac.rows = 0; ac.cols = 0; return; }
    cellW = Math.floor((ac.w - offx) / cols);
    cellH = Math.floor((ac.h - offy) / rows);
    if (cellW < 1 || cellH < 1) { ac.cellW = 0; ac.cellH = 0; ac.rows = 0; ac.cols = 0; return; }
  }
  ac.cellW = cellW; ac.cellH = cellH; ac.rows = rows; ac.cols = cols;
  var cells = [];
  for (var r = 0; r < rows; r++) for (var c = 0; c < cols; c++) {
    var x = offx + c * (cellW + gx);
    var y = offy + r * (cellH + gy);
    if (x + cellW > ac.w || y + cellH > ac.h) continue;
    cells.push({ x: x, y: y, w: cellW, h: cellH, idx: cells.length });
  }
  ac.cells = cells;
}

function acExportCanvas(cell) {
  var cv = makeCanvas(cell.w, cell.h);
  ctx2d(cv).drawImage(ac.img, cell.x, cell.y, cell.w, cell.h, 0, 0, cell.w, cell.h);
  return cv;
}

function renderAutoCropPreview() {
  var cv = $('#ac-canvas');
  if (!ac.img) { cv.width = 10; cv.height = 10; cv.getContext('2d').clearRect(0, 0, 10, 10); $('#ac-info').textContent = '—'; return; }
  var pad = 16, maxW = 720, maxH = 460;
  var scale = Math.min((maxW - pad * 2) / ac.w, (maxH - pad * 2) / ac.h);
  scale = Math.min(scale, 8);
  var dw = Math.max(1, Math.round(ac.w * scale)), dh = Math.max(1, Math.round(ac.h * scale));
  cv.width = dw + pad * 2; cv.height = dh + pad * 2;
  var ctx = cv.getContext('2d'); ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, cv.width, cv.height);
  paintChecker(ctx, cv.width, cv.height);
  ctx.drawImage(ac.img, pad, pad, dw, dh);
  ctx.font = '11px sans-serif'; ctx.textBaseline = 'top';
  ac.cells.forEach(function (cell) {
    var rx = pad + cell.x * scale, ry = pad + cell.y * scale, rw = cell.w * scale, rh = cell.h * scale;
    ctx.strokeStyle = (cell.idx === ac.sel) ? '#ffd166' : 'rgba(120,200,255,0.85)';
    ctx.lineWidth = (cell.idx === ac.sel) ? 2.5 : 1;
    ctx.strokeRect(rx + .5, ry + .5, rw - 1, rh - 1);
    if (scale >= 2) { ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillText(String(cell.idx + 1), rx + 2, ry + 2); }
  });
  var ok = ac.cells.length > 0 && ac.cellW > 0;
  $('#ac-info').textContent = ok
    ? '单元格 ' + ac.cellW + ' × ' + ac.cellH + '　·　' + ac.rows + ' 行 × ' + ac.cols + ' 列　·　共 ' + ac.cells.length + ' 帧'
    : '参数无效：单元格尺寸或行列数需 ≥ 1';
}

function renderAutoCropList() {
  var list = $('#ac-list');
  list.innerHTML = '';
  if (!ac.cells.length) { list.innerHTML = '<div class="list-empty">暂无可拆分单元格（请检查参数）</div>'; return; }
  ac.cells.forEach(function (cell) {
    var el = document.createElement('div');
    el.className = 'list-item ac-item' + (cell.idx === ac.sel ? ' sel' : '');
    el.dataset.id = cell.idx;
    var th = document.createElement('canvas');
    th.width = cell.w; th.height = cell.h; th.className = 'thumb';
    th.getContext('2d').drawImage(ac.img, cell.x, cell.y, cell.w, cell.h, 0, 0, cell.w, cell.h);
    var meta = document.createElement('div'); meta.className = 'li-meta';
    meta.innerHTML = '<div class="li-name">第 ' + (cell.idx + 1) + ' 帧</div><div class="li-sub">(' + cell.x + ', ' + cell.y + ')　' + cell.w + '×' + cell.h + '</div>';
    var exp = document.createElement('button'); exp.className = 'mini ac-exp'; exp.textContent = '导出'; exp.title = '导出这一帧 PNG';
    exp.addEventListener('click', function (e) { e.stopPropagation(); acExportOne(cell); });
    el.appendChild(th); el.appendChild(meta); el.appendChild(exp);
    el.addEventListener('click', function () { ac.sel = cell.idx; renderAutoCropPreview(); renderAutoCropList(); });
    list.appendChild(el);
  });
}

function acExportOne(cell) {
  if (!ac.img) return;
  var cv = acExportCanvas(cell);
  if (!cv) { toast('无法导出', 'err'); return; }
  canvasToBlob(cv, 'image/png').then(function (b) { downloadBlob(b, acPrefix() + '_' + String(cell.idx + 1).padStart(2, '0') + '.png'); toast('已导出第 ' + (cell.idx + 1) + ' 帧', 'ok'); });
}

function renderAutoCrop() { renderAutoCropPreview(); renderAutoCropList(); }

/* ---- 自动裁剪：事件 ---- */
function acApplyModeVisibility() {
  var byCell = ac.mode === 'cell';
  $$('.ac-by-cell').forEach(function (n) { n.hidden = !byCell; });
  $$('.ac-by-grid').forEach(function (n) { n.hidden = byCell; });
}
setupPicker({ zone: '#ac-drop', input: '#ac-input', btn: '#ac-pick', onFiles: addAcImage });
$('#ac-mode').addEventListener('change', function () { ac.mode = $('#ac-mode').value; acApplyModeVisibility(); acCompute(); renderAutoCrop(); });
['#ac-cw', '#ac-ch', '#ac-rows', '#ac-cols', '#ac-offx', '#ac-offy', '#ac-gapx', '#ac-gapy'].forEach(function (sel) {
  $(sel).addEventListener('input', function () { acCompute(); renderAutoCrop(); });
});
$('#ac-refresh').addEventListener('click', function () { acCompute(); renderAutoCrop(); toast('已刷新预览'); });
$('#ac-clear').addEventListener('click', function () {
  if (ac.url) URL.revokeObjectURL(ac.url);
  ac.img = null; ac.url = null; ac.w = 0; ac.h = 0; ac.sel = -1; ac.cells = []; ac.name = '';
  $('#ac-name').textContent = '未选择图片'; $('#ac-badge').textContent = '—';
  renderAutoCrop();
});
$('#ac-export-zip').addEventListener('click', function () {
  if (!ac.cells.length) { toast('没有可导出的单元格', 'err'); return; }
  var jobs = ac.cells.map(function (cell) {
    var cv = acExportCanvas(cell);
    return canvasToBlob(cv, 'image/png').then(blobBytes).then(function (bytes) {
      return { name: acPrefix() + '_' + String(cell.idx + 1).padStart(2, '0') + '.png', data: bytes };
    });
  });
  Promise.all(jobs).then(function (files) {
    downloadBlob(createZip(files), acPrefix() + '_' + files.length + '.zip');
    toast('已导出 ' + files.length + ' 帧 (ZIP)', 'ok');
  });
});
acApplyModeVisibility();

/* ================================================================== */
/*  初始状态                                                           */
/* ================================================================== */
renderCropList();
renderCropPreview();
renderStitch();
renderGif();
renderAutoCrop();

})();
