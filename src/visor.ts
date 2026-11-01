/**
 * Vista previa de las hojas con pdf.js (versión "legacy", que anda también
 * en teléfonos con navegadores no tan nuevos). Cada hoja se dibuja una sola
 * vez como imagen y se reutiliza.
 */
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import urlTrabajador from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { mascaraDesdePixeles, type Mascara } from './autoubicar';

GlobalWorkerOptions.workerSrc = urlTrabajador;

/** Recursos de pdf.js (fuentes estándar, decodificadores), copiados al publicar. */
const RECURSOS = new URL('pdfjs/', new URL(import.meta.env.BASE_URL, location.href)).href;

export type DocumentoPdf = PDFDocumentProxy;

export async function abrirPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  // pdf.js se queda con el buffer: se le pasa una copia.
  return getDocument({
    data: bytes.slice(),
    enableXfa: false,
    cMapUrl: `${RECURSOS}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${RECURSOS}standard_fonts/`,
    wasmUrl: `${RECURSOS}wasm/`,
    iccUrl: `${RECURSOS}iccs/`,
  }).promise;
}

export class Visor {
  private cache = new Map<number, Promise<string>>();
  private mascaras = new Map<number, Mascara>();
  private cola: Promise<unknown> = Promise.resolve();
  private cerrado = false;

  constructor(
    readonly doc: PDFDocumentProxy,
    private readonly anchoPx: number,
  ) {}

  get hojas() {
    return this.doc.numPages;
  }

  /** URL de una imagen de la hoja `n` (base 1). Se dibujan de a una para no saturar la memoria del teléfono. */
  imagen(n: number): Promise<string> {
    let p = this.cache.get(n);
    if (!p) {
      p = this.cola.then(() => this.dibujar(n));
      this.cola = p.catch(() => undefined);
      this.cache.set(n, p);
    }
    return p;
  }

  /** Mapa de tinta de la hoja `n` (para ubicar la firma donde no tape nada). */
  async mascara(n: number): Promise<Mascara> {
    await this.imagen(n);
    return this.mascaras.get(n)!;
  }

  /** Mapa de tinta si la hoja ya se dibujó. */
  mascaraLista(n: number): Mascara | undefined {
    return this.mascaras.get(n);
  }

  private async dibujar(n: number): Promise<string> {
    if (this.cerrado) throw new Error('cerrado');
    const pagina = await this.doc.getPage(n);
    const base = pagina.getViewport({ scale: 1 });
    const escala = Math.min(this.anchoPx / base.width, 4096 / Math.max(base.width, base.height));
    const vista = pagina.getViewport({ scale: escala });
    const lienzo = document.createElement('canvas');
    lienzo.width = Math.ceil(vista.width);
    lienzo.height = Math.ceil(vista.height);
    const ctx = lienzo.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, lienzo.width, lienzo.height);
    await pagina.render({ canvas: lienzo, canvasContext: ctx, viewport: vista }).promise;
    pagina.cleanup();
    this.mascaras.set(n, mascaraDesdePixeles(ctx.getImageData(0, 0, lienzo.width, lienzo.height).data, lienzo.width, lienzo.height));
    const blob = await new Promise<Blob>((ok, mal) =>
      lienzo.toBlob((b) => (b ? ok(b) : mal(new Error('No se pudo mostrar la hoja.'))), 'image/jpeg', 0.9),
    );
    lienzo.width = lienzo.height = 0;
    return URL.createObjectURL(blob);
  }

  async cerrar() {
    this.cerrado = true;
    for (const p of this.cache.values()) p.then((u) => URL.revokeObjectURL(u)).catch(() => undefined);
    this.cache.clear();
    this.mascaras.clear();
    await this.doc.loadingTask.destroy();
  }
}
