/**
 * Arma la imagen que se inserta en el PDF: la firma dibujada a mano y,
 * debajo, los datos que escribió el cliente (y la fecha, si se elige).
 * Fondo transparente, en alta resolución para que se imprima nítida.
 */

export interface OpcionesImagen {
  /** Firma ya dibujada y recortada (de `rasterizarFirma`), o null si no hay. */
  firma: HTMLCanvasElement | null;
  texto: string;
  fecha: string | null;
  color: string;
}

export interface ImagenFirma {
  png: Uint8Array;
  /** Ancho / alto. */
  aspecto: number;
  url: string;
  ancho: number;
  alto: number;
}

const ANCHO_MAX = 1200;
/** Ancho al que se lleva el recuadro de firma completo (la firma real suele ocupar menos). */
const ANCHO_RECUADRO = 900;
const ALTO_FIRMA_MAX = 360;
/** Los datos se cortan en líneas de este ancho (o el de la firma, si es mayor) para que no queden diminutos. */
const ANCHO_TEXTO_MIN = 820;
const MARGEN = 24;
const FUENTE = '"Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif';
const TAM_TEXTO = 46;
const TAM_FECHA = 32;

function cargarImagen(src: string): Promise<HTMLImageElement> {
  return new Promise((ok, mal) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => mal(new Error('No se pudo dibujar la firma.'));
    img.src = src;
  });
}

/** Recorta el lienzo a la zona con trazos (canal alfa). */
function recortar(lienzo: HTMLCanvasElement): HTMLCanvasElement | null {
  const ctx = lienzo.getContext('2d')!;
  const { width: w, height: h } = lienzo;
  const datos = ctx.getImageData(0, 0, w, h).data;
  let x0 = w,
    y0 = h,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (datos[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const borde = 6;
  x0 = Math.max(0, x0 - borde);
  y0 = Math.max(0, y0 - borde);
  x1 = Math.min(w - 1, x1 + borde);
  y1 = Math.min(h - 1, y1 + borde);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext('2d')!.drawImage(lienzo, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

/** Dibuja en alta resolución la firma (SVG de signature_pad) y la recorta a los trazos. */
export async function rasterizarFirma(svgUrl: string): Promise<HTMLCanvasElement | null> {
  const img = await cargarImagen(svgUrl);
  const anchoSvg = img.naturalWidth || img.width;
  const altoSvg = img.naturalHeight || img.height;
  if (!anchoSvg || !altoSvg) return null;
  const escala = ANCHO_RECUADRO / anchoSvg;
  const lienzo = document.createElement('canvas');
  lienzo.width = Math.round(anchoSvg * escala);
  lienzo.height = Math.round(altoSvg * escala);
  lienzo.getContext('2d')!.drawImage(img, 0, 0, lienzo.width, lienzo.height);
  return recortar(lienzo);
}

/** Corta el texto en líneas que entren en `ancho` (respeta los saltos de línea del cliente). */
function partirLineas(ctx: CanvasRenderingContext2D, texto: string, ancho: number): string[] {
  const lineas: string[] = [];
  for (const parrafo of texto.replace(/\r/g, '').split('\n')) {
    const palabras = parrafo.split(/\s+/).filter(Boolean);
    if (!palabras.length) {
      lineas.push('');
      continue;
    }
    let actual = '';
    for (const palabra of palabras) {
      const prueba = actual ? `${actual} ${palabra}` : palabra;
      if (ctx.measureText(prueba).width <= ancho || !actual) {
        actual = prueba;
      } else {
        lineas.push(actual);
        actual = palabra;
      }
      // Palabras larguísimas (un mail, un CUIT sin espacios): se cortan por letras.
      while (ctx.measureText(actual).width > ancho && actual.length > 1) {
        let corte = actual.length - 1;
        while (corte > 1 && ctx.measureText(actual.slice(0, corte)).width > ancho) corte--;
        lineas.push(actual.slice(0, corte));
        actual = actual.slice(corte);
      }
    }
    lineas.push(actual);
  }
  while (lineas.length && !lineas[lineas.length - 1]) lineas.pop();
  while (lineas.length && !lineas[0]) lineas.shift();
  return lineas;
}

export async function componerImagen({ firma, texto, fecha, color }: OpcionesImagen): Promise<ImagenFirma | null> {
  const medir = document.createElement('canvas').getContext('2d')!;
  const anchoUtil = ANCHO_MAX - 2 * MARGEN;

  let anchoFirma = 0;
  let altoFirma = 0;
  if (firma) {
    const escala = Math.min(1, ALTO_FIRMA_MAX / firma.height, anchoUtil / firma.width);
    anchoFirma = firma.width * escala;
    altoFirma = firma.height * escala;
  }

  medir.font = `500 ${TAM_TEXTO}px ${FUENTE}`;
  const lineas = partirLineas(medir, texto, Math.min(anchoUtil, Math.max(anchoFirma, ANCHO_TEXTO_MIN)));
  const anchoTexto = Math.max(0, ...lineas.map((l) => medir.measureText(l).width));
  medir.font = `400 ${TAM_FECHA}px ${FUENTE}`;
  const anchoFecha = fecha ? medir.measureText(fecha).width : 0;

  if (!firma && !lineas.length) return null;
  const anchoContenido = Math.max(anchoFirma, anchoTexto, anchoFecha, 360);
  const anchoLinea = Math.min(anchoUtil, Math.max(anchoFirma, anchoTexto) * 1.05);
  const altoLinea = TAM_TEXTO * 1.28;

  let alto = MARGEN;
  if (firma) alto += altoFirma + 14;
  alto += 4 + 16; // línea de firma
  alto += lineas.length * altoLinea;
  if (fecha) alto += 8 + TAM_FECHA * 1.3;
  alto += MARGEN;

  const lienzo = document.createElement('canvas');
  lienzo.width = Math.ceil(anchoContenido + 2 * MARGEN);
  lienzo.height = Math.ceil(alto);
  const ctx = lienzo.getContext('2d')!;
  const cx = lienzo.width / 2;
  let y = MARGEN;

  if (firma) {
    ctx.drawImage(firma, cx - anchoFirma / 2, y, anchoFirma, altoFirma);
    y += altoFirma + 14;
  }
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.75;
  ctx.fillRect(cx - anchoLinea / 2, y, anchoLinea, 3);
  ctx.globalAlpha = 1;
  y += 4 + 16;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = `500 ${TAM_TEXTO}px ${FUENTE}`;
  for (const l of lineas) {
    ctx.fillText(l, cx, y);
    y += altoLinea;
  }
  if (fecha) {
    y += 8;
    ctx.globalAlpha = 0.85;
    ctx.font = `400 ${TAM_FECHA}px ${FUENTE}`;
    ctx.fillText(fecha, cx, y);
    ctx.globalAlpha = 1;
  }

  const blob = await new Promise<Blob>((ok, mal) =>
    lienzo.toBlob((b) => (b ? ok(b) : mal(new Error('No se pudo generar la imagen.'))), 'image/png'),
  );
  return {
    png: new Uint8Array(await blob.arrayBuffer()),
    aspecto: lienzo.width / lienzo.height,
    url: URL.createObjectURL(blob),
    ancho: lienzo.width,
    alto: lienzo.height,
  };
}

/**
 * Proporción aproximada (ancho / alto) de la imagen antes de que haya una
 * firma dibujada, para reservarle lugar en la hoja.
 */
export function aspectoEstimado(texto: string, conFecha: boolean): number {
  const lineas = texto.trim() ? texto.trim().split('\n').length : 0;
  const alto = 2 * MARGEN + 230 + 20 + lineas * TAM_TEXTO * 1.28 + (conFecha ? 8 + TAM_FECHA * 1.3 : 0);
  return 760 / alto;
}

export function fechaDeFirma(d = new Date()): string {
  const dos = (n: number) => String(n).padStart(2, '0');
  return `Firmado el ${dos(d.getDate())}/${dos(d.getMonth() + 1)}/${d.getFullYear()} a las ${dos(d.getHours())}:${dos(d.getMinutes())} h`;
}
