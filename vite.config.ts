/// <reference types="vitest/config" />
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// BASE_PATH: subdirectorio donde se publica (GitHub Pages: /firma/).
const base = process.env.BASE_PATH ?? '/';

/**
 * Copia los recursos de pdf.js (fuentes estándar, mapas de caracteres y
 * decodificadores de imágenes de documentos escaneados) y agrega una
 * política de seguridad estricta a las páginas publicadas.
 */
function recursosPdf(): Plugin {
  const origen = resolve(__dirname, 'node_modules/pdfjs-dist');
  const carpetas = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];
  // QuickJS sólo sirve para ejecutar JavaScript embebido en PDF (desactivado).
  const omitir = (nombre: string) => nombre.startsWith('quickjs');
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' data: blob: https://api.github.com",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join('; ');
  return {
    name: 'recursos-pdf',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /\/pdfjs\/([\w-]+)\/([\w.-]+)$/.exec((req.url ?? '').split('?')[0]);
        if (!m || !carpetas.includes(m[1])) return next();
        try {
          res.end(readFileSync(join(origen, m[1], m[2])));
        } catch {
          next();
        }
      });
    },
    generateBundle() {
      for (const carpeta of carpetas) {
        for (const nombre of readdirSync(join(origen, carpeta))) {
          if (omitir(nombre)) continue;
          this.emitFile({ type: 'asset', fileName: `pdfjs/${carpeta}/${nombre}`, source: readFileSync(join(origen, carpeta, nombre)) });
        }
      }
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (ctx.server) return html;
        return html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`);
      },
    },
  };
}

export default defineConfig({
  base,
  plugins: [recursosPdf()],
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: {
        cliente: resolve(__dirname, 'index.html'),
        estudio: resolve(__dirname, 'estudio/index.html'),
      },
      output: {
        manualChunks(id) {
          if (/node_modules\/pdfjs-dist\//.test(id)) return 'pdfjs';
          if (/node_modules\/(pdf-lib|@pdf-lib|pako|tslib)\//.test(id)) return 'pdflib';
          if (/node_modules\/signature_pad\//.test(id)) return 'trazo';
          // Lo que comparten la página de firma y el panel del estudio.
          if (/\/src\/(cifrado|enlace|estampar|ubicacion|github|almacen)\.ts$|\/src\/firma\.css$/.test(id)) return 'comun';
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
