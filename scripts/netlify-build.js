'use strict';

/**
 * Netlify build step.
 *
 * The client is plain static files, but the Netlify deployment has no
 * Socket.IO server, so the published copy drops that script tag (which would
 * only 404) and marks the transport as polling. Everything else is copied
 * verbatim from public/ into dist/.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'dist');

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(SOURCE, OUT, { recursive: true });

const indexPath = path.join(OUT, 'index.html');
const html = fs
  .readFileSync(indexPath, 'utf8')
  .replace(
    /\s*<!-- Present on the Node deployment only[\s\S]*?<script src="\/socket\.io\/socket\.io\.js"[^>]*><\/script>/,
    '\n  <script>window.MIM_TRANSPORT = "poll";</script>'
  );

if (html.includes('socket.io.js')) {
  throw new Error('netlify-build: the socket.io script tag was not removed');
}

fs.writeFileSync(indexPath, html);
console.log(`netlify-build: wrote ${path.relative(ROOT, OUT)} (polling transport)`);
