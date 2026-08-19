/* Canvas meme renderer: template image + classic top/bottom impact caption. */
(function () {
  'use strict';

  const CANVAS_WIDTH = 900;
  const FONT_STACK = "Impact, 'Anton', 'Arial Black', 'Haettenschweiler', 'Arial Narrow Bold', sans-serif";
  const cache = new Map(); // url -> Promise<{image, ok, width, height}>
  const HEBREW = /[֐-׿؀-ۿ]/;

  function loadImage(url) {
    if (cache.has(url)) return cache.get(url);
    const promise = new Promise((resolve) => {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.onload = () =>
        resolve({ image, ok: true, width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => {
        // Retry once without CORS: some hosts serve the bytes but not the header.
        const plain = new Image();
        plain.onload = () =>
          resolve({ image: plain, ok: true, tainted: true, width: plain.naturalWidth, height: plain.naturalHeight });
        plain.onerror = () => resolve({ image: null, ok: false, width: 1, height: 1 });
        plain.src = url;
      };
      image.src = url;
    });
    cache.set(url, promise);
    return promise;
  }

  /** Warm the cache so the next round's image is ready before it is needed. */
  function preload(templates) {
    (templates || []).forEach((t) => t && t.url && loadImage(t.url));
  }

  function hashHue(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) % 360;
    return hash;
  }

  function drawPlaceholder(ctx, width, height, template) {
    const hue = hashHue(template && template.id ? template.id : 'meme');
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, `hsl(${hue}, 70%, 55%)`);
    gradient.addColorStop(1, `hsl(${(hue + 60) % 360}, 70%, 35%)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${Math.round(width * 0.07)}px ${FONT_STACK}`;
    ctx.fillText(template && template.name ? template.name : 'MEME', width / 2, height / 2);
  }

  function wrap(ctx, text, maxWidth) {
    const words = text.split(' ');
    const lines = [];
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxWidth || !line) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  /**
   * Draw one caption box centred on `centerY` (0 = top of the image, 1 = the
   * bottom) and report the band it occupies so the UI can let players drag it.
   */
  function drawCaption(ctx, rawText, width, height, centerY) {
    const text = (rawText || '').trim();
    if (!text) return null;
    const value = HEBREW.test(text) ? text : text.toUpperCase();
    ctx.direction = HEBREW.test(text) ? 'rtl' : 'ltr';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;

    const maxWidth = width * 0.92;
    const maxHeight = height * 0.45;
    let size = Math.round(width * 0.11);
    let lines = [];
    while (size > 14) {
      ctx.font = `${size}px ${FONT_STACK}`;
      lines = wrap(ctx, value, maxWidth);
      const fits =
        lines.length * size * 1.12 <= maxHeight &&
        lines.every((l) => ctx.measureText(l).width <= maxWidth);
      if (fits) break;
      size -= 2;
    }

    ctx.font = `${size}px ${FONT_STACK}`;
    ctx.lineWidth = Math.max(2, size / 7);
    ctx.strokeStyle = '#000';
    ctx.fillStyle = '#fff';

    const lineHeight = size * 1.1;
    const blockHeight = (lines.length - 1) * lineHeight + size;
    const margin = height * 0.02;
    // Keep the whole block on the image however far the player drags it.
    const top = Math.max(
      margin,
      Math.min(height - margin - blockHeight, centerY * height - blockHeight / 2)
    );

    lines.forEach((line, i) => {
      const baseline = top + size * 0.85 + i * lineHeight;
      ctx.strokeText(line, width / 2, baseline);
      ctx.fillText(line, width / 2, baseline);
    });
    ctx.direction = 'inherit';
    return { top, bottom: top + blockHeight, height: blockHeight };
  }

  /**
   * Render a meme into `canvas`. Safe to call on every keystroke — the image
   * is cached and the whole draw is a handful of canvas ops.
   */
  async function draw(canvas, meme) {
    if (!canvas || !meme || !meme.template) return;
    const token = (canvas.__drawToken = (canvas.__drawToken || 0) + 1);
    const loaded = await loadImage(meme.template.url);
    if (canvas.__drawToken !== token) return; // a newer draw won the race

    const ratio = loaded.ok ? loaded.height / loaded.width : 1;
    const width = CANVAS_WIDTH;
    const height = Math.round(width * Math.min(Math.max(ratio, 0.5), 1.7));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);
    if (loaded.ok) {
      // cover-fit so no template is letterboxed
      const scale = Math.max(width / loaded.width, height / loaded.height);
      const w = loaded.width * scale;
      const h = loaded.height * scale;
      ctx.drawImage(loaded.image, (width - w) / 2, (height - h) / 2, w, h);
    } else {
      drawPlaceholder(ctx, width, height, meme.template);
    }

    const boxes = [];
    (meme.captions || []).forEach((caption, index) => {
      const box = drawCaption(ctx, caption.text, width, height, caption.y);
      if (box) boxes.push({ index, ...box });
    });
    canvas.__captionBoxes = { width, height, boxes };
    return canvas.__captionBoxes;
  }

  /**
   * Which caption a pointer at `ratioY` (0..1 of the canvas height) is grabbing:
   * the one whose drawn band contains it, otherwise the nearest one.
   */
  function captionAt(canvas, ratioY) {
    const layout = canvas.__captionBoxes;
    if (!layout || !layout.boxes.length) return null;
    const y = ratioY * layout.height;
    const hit = layout.boxes.find((box) => y >= box.top - 8 && y <= box.bottom + 8);
    if (hit) return hit.index;
    return layout.boxes.reduce((best, box) => {
      const distance = Math.abs((box.top + box.bottom) / 2 - y);
      return best === null || distance < best.distance ? { index: box.index, distance } : best;
    }, null).index;
  }

  window.MemeRender = { draw, preload, loadImage, captionAt };
})();
