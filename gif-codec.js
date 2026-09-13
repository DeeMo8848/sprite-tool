/* =============================================================
 * gif-codec.js  —  无依赖 GIF 解码 / 编码器（浏览器 + Node 通用）
 * -------------------------------------------------------------
 *  decodeGif(buffer)  -> { width, height, frames:[{ data:Uint8ClampedArray(RGBA), delay:ms }] }
 *  encodeGif(frames, width, height, opts)
 *      frames: [{ data:Uint8ClampedArray(RGBA), delay:ms }]
 *      opts:   { loop?: number }  0 = 无限循环
 *      -> Uint8Array (GIF89a, 含透明通道)
 * ============================================================= */
(function (root) {
  'use strict';

  var MAX_CODE = 4096;

  /* ---------------- 解码 ---------------- */

  function readColorTable(b, off, n) {
    var t = new Uint8Array(n * 3);
    for (var i = 0; i < n * 3; i++) t[i] = b[off + i];
    return t;
  }

  function readSubBlocks(b, state) {
    var chunks = [], total = 0;
    while (state.p < b.length) {
      var n = b[state.p++];
      if (n === 0) break;
      chunks.push(b.subarray(state.p, state.p + n));
      state.p += n;
      total += n;
    }
    var out = new Uint8Array(total), off = 0;
    for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], off); off += chunks[i].length; }
    return out;
  }

  function skipSubBlocks(b, state) {
    while (state.p < b.length) {
      var n = b[state.p++];
      if (n === 0) break;
      state.p += n;
    }
  }

  function lzwDecode(minCodeSize, data, pixelCount) {
    var clearCode = 1 << minCodeSize;
    var eoiCode = clearCode + 1;
    var codeSize = minCodeSize + 1;
    var dict, prev = null;
    var out = new Uint8Array(pixelCount);
    var oi = 0, bitPos = 0;
    var totalBits = data.length * 8;

    function reset() {
      dict = [];
      for (var i = 0; i < clearCode; i++) dict.push([i]);
      dict.push([]); // clear
      dict.push([]); // eoi
      codeSize = minCodeSize + 1;
    }
    reset();

    function readCode() {
      var code = 0;
      for (var i = 0; i < codeSize; i++) {
        if (bitPos >= totalBits) return -1;
        code |= ((data[bitPos >> 3] >> (bitPos & 7)) & 1) << i;
        bitPos++;
      }
      return code;
    }

    while (oi < pixelCount) {
      var code = readCode();
      if (code < 0) break;
      if (code === clearCode) { reset(); prev = null; continue; }
      if (code === eoiCode) break;
      var entry;
      if (code < dict.length) entry = dict[code];
      else if (code === dict.length && prev) entry = prev.concat([prev[0]]);
      else break;
      for (var k = 0; k < entry.length && oi < pixelCount; k++) out[oi++] = entry[k];
      if (prev !== null && dict.length < MAX_CODE) {
        dict.push(prev.concat([entry[0]]));
        if (dict.length === (1 << codeSize) && codeSize < 12) codeSize++;
      }
      prev = entry;
    }
    return out;
  }

  function clearRect(buf, W, H, r) {
    for (var y = r.top; y < r.top + r.fh; y++) {
      if (y < 0 || y >= H) continue;
      for (var x = r.left; x < r.left + r.fw; x++) {
        if (x < 0 || x >= W) continue;
        var o = (y * W + x) * 4;
        buf[o] = buf[o + 1] = buf[o + 2] = buf[o + 3] = 0;
      }
    }
  }

  function interlaceRows(fh) {
    var rows = [], i;
    for (i = 0; i < fh; i += 8) rows.push(i);
    for (i = 4; i < fh; i += 8) rows.push(i);
    for (i = 2; i < fh; i += 4) rows.push(i);
    for (i = 1; i < fh; i += 2) rows.push(i);
    return rows;
  }

  function drawFrame(canvas, W, H, idx, ct, fw, fh, left, top, interlace, transparent, tIndex) {
    var passRows = interlace ? interlaceRows(fh) : null;
    for (var k = 0; k < fh; k++) {
      var y = interlace ? passRows[k] : k;
      var dy = top + y;
      if (dy < 0 || dy >= H) continue;
      var base = k * fw;
      for (var x = 0; x < fw; x++) {
        var ci = idx[base + x];
        if (transparent && ci === tIndex) continue;
        var dx = left + x;
        if (dx < 0 || dx >= W) continue;
        var co = ci * 3, o = (dy * W + dx) * 4;
        canvas[o] = ct[co]; canvas[o + 1] = ct[co + 1]; canvas[o + 2] = ct[co + 2]; canvas[o + 3] = 255;
      }
    }
  }

  function decodeGif(buffer) {
    var b = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (b.length < 14 || b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) {
      throw new Error('不是有效的 GIF 文件');
    }
    var state = { p: 6 };
    var width = b[state.p] | (b[state.p + 1] << 8); state.p += 2;
    var height = b[state.p] | (b[state.p + 1] << 8); state.p += 2;
    var packed = b[state.p++];
    b[state.p++]; // background color index
    state.p++;     // pixel aspect ratio

    var gct = null;
    if (packed & 0x80) {
      var gn = 2 << (packed & 7);
      gct = readColorTable(b, state.p, gn);
      state.p += gn * 3;
    }

    var canvas = new Uint8ClampedArray(width * height * 4);
    var frames = [];
    var gce = null;
    var lastRect = null, lastDisposal = 0, restoreSnapshot = null;

    while (state.p < b.length) {
      var blk = b[state.p++];
      if (blk === 0x3B) break;                       // trailer
      if (blk === 0x21) {                            // extension
        var label = b[state.p++];
        if (label === 0xF9) {                        // graphic control
          state.p++;                                 // block size (=4)
          var flags = b[state.p++];
          var delay = b[state.p] | (b[state.p + 1] << 8); state.p += 2;
          var tIndex = b[state.p++];
          state.p++;                                 // terminator
          gce = {
            disposal: (flags >> 2) & 7,
            transparent: !!(flags & 0x01),
            tIndex: tIndex,
            delay: delay * 10
          };
        } else if (label === 0x01) {                 // plain text
          state.p++; state.p += 12;
          skipSubBlocks(b, state);
        } else {
          skipSubBlocks(b, state);
        }
      } else if (blk === 0x2C) {                     // image descriptor
        var left = b[state.p] | (b[state.p + 1] << 8); state.p += 2;
        var top = b[state.p] | (b[state.p + 1] << 8); state.p += 2;
        var fw = b[state.p] | (b[state.p + 1] << 8); state.p += 2;
        var fh = b[state.p] | (b[state.p + 1] << 8); state.p += 2;
        var lp = b[state.p++];
        var ct = gct;
        if (lp & 0x80) {
          var ln = 2 << (lp & 7);
          ct = readColorTable(b, state.p, ln);
          state.p += ln * 3;
        }
        var interlace = !!(lp & 0x40);
        var minCodeSize = b[state.p++];
        var data = readSubBlocks(b, state);

        // 处理上一帧的处置方式（disposal）
        if (lastRect && lastDisposal === 2) {
          clearRect(canvas, width, height, lastRect);
        } else if (lastRect && lastDisposal === 3 && restoreSnapshot) {
          canvas.set(restoreSnapshot);
        }
        var before = (gce && gce.disposal === 3) ? canvas.slice() : null;

        if (!ct) throw new Error('GIF 缺少调色板');
        var idx = lzwDecode(minCodeSize, data, fw * fh);
        drawFrame(canvas, width, height, idx, ct, fw, fh, left, top, interlace,
          gce && gce.transparent, gce ? gce.tIndex : -1);

        frames.push({ data: canvas.slice(), delay: gce ? gce.delay : 100 });

        lastRect = { left: left, top: top, fw: fw, fh: fh };
        lastDisposal = gce ? gce.disposal : 0;
        restoreSnapshot = before;
        gce = null;
      } else {
        break; // 未知块，停止解析
      }
    }

    if (!frames.length) throw new Error('GIF 中未找到图像帧');
    return { width: width, height: height, frames: frames };
  }

  /* ---------------- 编码 ---------------- */

  function boxRange(box) {
    var rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0;
    for (var i = 0; i < box.length; i++) {
      var c = box[i];
      if (c.r < rmin) rmin = c.r; if (c.r > rmax) rmax = c.r;
      if (c.g < gmin) gmin = c.g; if (c.g > gmax) gmax = c.g;
      if (c.b < bmin) bmin = c.b; if (c.b > bmax) bmax = c.b;
    }
    var dr = rmax - rmin, dg = gmax - gmin, db = bmax - bmin;
    var channel = 'r', max = dr;
    if (dg > max) { channel = 'g'; max = dg; }
    if (db > max) { channel = 'b'; max = db; }
    return { channel: channel, max: max };
  }

  function medianCut(colors, maxColors) {
    var boxes = [colors];
    while (boxes.length < maxColors) {
      var bi = -1, bestScore = 0;
      for (var i = 0; i < boxes.length; i++) {
        if (boxes[i].length < 2) continue;
        var s = boxRange(boxes[i]).max;
        if (s > bestScore) { bestScore = s; bi = i; }
      }
      if (bi < 0 || bestScore === 0) break;
      var box = boxes[bi];
      var ch = boxRange(box).channel;
      box.sort(function (a, b) { return a[ch] - b[ch]; });
      var total = 0, k;
      for (k = 0; k < box.length; k++) total += box[k].count;
      var acc = 0, split = 1;
      for (k = 0; k < box.length; k++) { acc += box[k].count; if (acc >= total / 2) { split = k + 1; break; } }
      if (split >= box.length) split = box.length - 1;
      if (split < 1) split = 1;
      boxes.splice(bi, 1, box.slice(0, split), box.slice(split));
    }
    return boxes.map(function (bx) {
      var r = 0, g = 0, b = 0, n = 0;
      for (var i = 0; i < bx.length; i++) {
        r += bx[i].r * bx[i].count; g += bx[i].g * bx[i].count; b += bx[i].b * bx[i].count; n += bx[i].count;
      }
      if (!n) return { r: 0, g: 0, b: 0 };
      return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
    });
  }

  function lzwEncode(minCodeSize, pixels) {
    var clearCode = 1 << minCodeSize;
    var eoiCode = clearCode + 1;
    var codeSize, next, dict, out = [], cur = 0, curBits = 0;

    function emit(code) {
      cur |= code << curBits;
      curBits += codeSize;
      while (curBits >= 8) { out.push(cur & 0xFF); cur >>= 8; curBits -= 8; }
    }
    function resetDict() {
      dict = new Map();
      next = eoiCode + 1;
      codeSize = minCodeSize + 1;
    }
    resetDict();
    emit(clearCode);

    var prefix = pixels[0];
    for (var i = 1; i < pixels.length; i++) {
      var k = pixels[i];
      var key = prefix * MAX_CODE + k;
      if (dict.has(key)) { prefix = dict.get(key); continue; }
      emit(prefix);
      // 码长增长检查必须在写入新词条之前（与解码端 dict.length 对齐）
      if (next === (1 << codeSize) && codeSize < 12) codeSize++;
      dict.set(key, next++);
      if (next === MAX_CODE) { emit(clearCode); resetDict(); }
      prefix = k;
    }
    emit(prefix);
    emit(eoiCode);
    if (curBits > 0) out.push(cur & 0xFF);
    return out;
  }

  function encodeGif(frames, width, height, options) {
    options = options || {};
    var loop = (options.loop === undefined) ? 0 : options.loop;
    var MAXC = 255; // 0 号索引保留给透明色

    // 1) 统计颜色
    var colorMap = new Map(), f, d, i;
    for (var fi = 0; fi < frames.length; fi++) {
      d = frames[fi].data;
      for (i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 128) continue;
        var key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
        colorMap.set(key, (colorMap.get(key) || 0) + 1);
      }
    }
    var colors = [];
    colorMap.forEach(function (count, key) {
      colors.push({ r: (key >> 16) & 255, g: (key >> 8) & 255, b: key & 255, count: count });
    });

    var palette;
    if (colors.length === 0) palette = [{ r: 0, g: 0, b: 0 }];
    else if (colors.length <= MAXC) palette = colors.map(function (c) { return { r: c.r, g: c.g, b: c.b }; });
    else palette = medianCut(colors, MAXC);
    if (!palette.length) palette = [{ r: 0, g: 0, b: 0 }];

    // 2) 颜色 -> 索引（缓存 + 最近邻）
    var idxCache = new Map();
    function colorIndex(r, g, b) {
      var k = (r << 16) | (g << 8) | b;
      var v = idxCache.get(k);
      if (v !== undefined) return v;
      var best = 0, bestD = Infinity;
      for (var i = 0; i < palette.length; i++) {
        var p = palette[i];
        var dr = r - p.r, dg = g - p.g, db = b - p.b;
        var dd = dr * dr + dg * dg + db * db;
        if (dd < bestD) { bestD = dd; best = i; if (dd === 0) break; }
      }
      var res = best + 1;
      idxCache.set(k, res);
      return res;
    }

    // 3) 写出
    var bytes = [];
    function u8(v) { bytes.push(v & 255); }
    function u16(v) { bytes.push(v & 255, (v >> 8) & 255); }
    function str(s) { for (var i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i)); }

    str('GIF89a');
    u16(width); u16(height);
    u8(0xF7);      // 全局色表: 有, 色深7, 大小7 -> 256
    u8(0);         // 背景色索引
    u8(0);         // 像素宽高比
    for (i = 0; i < 256; i++) {
      var c = (i >= 1 && i <= palette.length) ? palette[i - 1] : { r: 0, g: 0, b: 0 };
      u8(c.r); u8(c.g); u8(c.b);
    }
    // NETSCAPE 循环扩展
    u8(0x21); u8(0xFF); u8(0x0B); str('NETSCAPE2.0'); u8(0x03); u8(0x01); u16(loop); u8(0x00);

    for (var fi2 = 0; fi2 < frames.length; fi2++) {
      f = frames[fi2];
      var delayCs = Math.max(0, Math.round((f.delay || 0) / 10));
      var disposal = 2; // restore to background
      var gceFlags = (disposal << 2) | 0x01; // 透明标志开
      u8(0x21); u8(0xF9); u8(0x04); u8(gceFlags); u16(delayCs); u8(0x00); u8(0x00);

      u8(0x2C); u16(0); u16(0); u16(width); u16(height); u8(0x00);

      var idx = new Uint8Array(width * height);
      d = f.data;
      var p = 0;
      for (i = 0; i < d.length; i += 4, p++) {
        idx[p] = (d[i + 3] < 128) ? 0 : colorIndex(d[i], d[i + 1], d[i + 2]);
      }
      u8(8); // min code size
      var lzw = lzwEncode(8, idx);
      for (i = 0; i < lzw.length; i += 255) {
        var end = Math.min(i + 255, lzw.length);
        u8(end - i);
        for (var j = i; j < end; j++) u8(lzw[j]);
      }
      u8(0x00);
    }
    u8(0x3B);
    return new Uint8Array(bytes);
  }

  var api = { decodeGif: decodeGif, encodeGif: encodeGif, version: '1.0.0' };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.GifCodec = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
