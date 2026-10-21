import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const faceMeshFiles = new Set([
  'face_mesh.js',
  'face_mesh.binarypb',
  'face_mesh_solution_packed_assets_loader.js',
  'face_mesh_solution_packed_assets.data',
  'face_mesh_solution_simd_wasm_bin.js',
  'face_mesh_solution_simd_wasm_bin.wasm',
  'face_mesh_solution_wasm_bin.js',
  'face_mesh_solution_wasm_bin.wasm',
]);
const publicFiles = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/styles.css', 'styles.css'],
  ['/src/app.js', 'src/app.js'],
  ['/src/calibration.js', 'src/calibration.js'],
  ['/src/bootstrap.js', 'src/bootstrap.js'],
]);
const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.data', 'application/octet-stream'],
  ['.binarypb', 'application/octet-stream'],
]);

function resolvePublicFile(pathname) {
  const directFile = publicFiles.get(pathname);
  if (directFile) return resolve(root, directFile);
  const modelPrefix = '/node_modules/@mediapipe/face_mesh/';
  if (pathname.startsWith(modelPrefix)) {
    const basename = pathname.slice(modelPrefix.length);
    if (faceMeshFiles.has(basename)) return resolve(root, 'node_modules/@mediapipe/face_mesh', basename);
  }
  return null;
}

function securityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(self)');
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob: mediastream:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'",
  );
}

const server = createServer((request, response) => {
  securityHeaders(response);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end('Method not allowed');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  } catch {
    response.writeHead(400);
    response.end('Bad request');
    return;
  }
  const filePath = resolvePublicFile(pathname);
  if (!filePath || (filePath !== root && !filePath.startsWith(`${root}${sep}`))) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  let fileStats;
  try {
    fileStats = statSync(filePath);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Missing asset. Run npm install, then reload the app.');
    return;
  }

  response.writeHead(200, {
    'Content-Type': contentTypes.get(extname(filePath)) ?? 'application/octet-stream',
    'Content-Length': fileStats.size,
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
});

function readArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const host = readArgument('--host', process.env.HOST || '127.0.0.1');
const port = Number(readArgument('--port', process.env.PORT || '8000'));
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer from 1 to 65535.');
}

server.listen(port, host, () => {
  const displayHost = host === '0.0.0.0' ? 'localhost' : host;
  console.log(`Eye tracker ready at http://${displayHost}:${port}`);
  console.log('Only the app, its local MediaPipe assets, and no user data are served.');
});
