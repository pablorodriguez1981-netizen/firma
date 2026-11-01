/**
 * Ubicación automática de la firma: analiza la hoja dibujada, encuentra
 * dónde termina el texto y pone la firma justo debajo. Si no entra, prueba
 * más chica y después busca cualquier lugar libre; si no hay, avisa.
 * Funciona con texto digital y con hojas escaneadas (mira los píxeles).
 */
import { ubicacionAbajo, type BordeH, type Rect, type Tamano, type Ubicacion } from './ubicacion';

/** Mapa de tinta de la hoja: 1 donde hay algo impreso. */
export interface Mascara {
  ancho: number;
  alto: number;
  datos: Uint8Array;
}

/** Ancho (en celdas) del mapa de tinta. */
export const ANCHO_MASCARA = 240;

/**
 * Mapa de tinta a partir de los píxeles RGBA de la hoja. El umbral se toma
 * relativo al color del papel (las hojas escaneadas suelen ser grisáceas) y
 * se ignora un borde fino (sombras del escáner).
 */
export function mascaraDesdePixeles(rgba: Uint8ClampedArray | Uint8Array, ancho: number, alto: number, anchoMascara = ANCHO_MASCARA): Mascara {
  const n = ancho * alto;
  const hist = new Uint32Array(256);
  const lum = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const l = (rgba[i * 4] * 299 + rgba[i * 4 + 1] * 587 + rgba[i * 4 + 2] * 114) / 1000;
    lum[i] = l;
    hist[lum[i]]++;
  }
  let papel = 255;
  let max = -1;
  for (let l = 128; l < 256; l++) {
    if (hist[l] > max) {
      max = hist[l];
      papel = l;
    }
  }
  const umbral = Math.max(60, papel - 45);
  const mw = Math.min(anchoMascara, ancho);
  const mh = Math.max(1, Math.round((alto * mw) / ancho));
  const cuenta = new Uint16Array(mw * mh);
  const fx = mw / ancho;
  const fy = mh / alto;
  for (let y = 0; y < alto; y++) {
    const cy = Math.min(mh - 1, Math.floor(y * fy)) * mw;
    for (let x = 0; x < ancho; x++) {
      if (lum[y * ancho + x] < umbral) cuenta[cy + Math.min(mw - 1, Math.floor(x * fx))]++;
    }
  }
  const datos = new Uint8Array(mw * mh);
  const borde = Math.round(Math.min(mw, mh) * 0.02);
  // Una celda tiene tinta si tiene al menos 2 píxeles oscuros (descarta motas sueltas).
  const minimo = Math.min(2, Math.ceil(1 / (fx * fy)));
  for (let y = borde; y < mh - borde; y++) {
    for (let x = borde; x < mw - borde; x++) {
      if (cuenta[y * mw + x] >= minimo) datos[y * mw + x] = 1;
    }
  }
  return { ancho: mw, alto: mh, datos };
}

const integrales = new WeakMap<Mascara, Uint32Array>();

function integral(m: Mascara): Uint32Array {
  let s = integrales.get(m);
  if (s) return s;
  const w = m.ancho + 1;
  s = new Uint32Array(w * (m.alto + 1));
  for (let y = 0; y < m.alto; y++) {
    let fila = 0;
    for (let x = 0; x < m.ancho; x++) {
      fila += m.datos[y * m.ancho + x];
      s[(y + 1) * w + x + 1] = s[y * w + x + 1] + fila;
    }
  }
  integrales.set(m, s);
  return s;
}

/** Celdas con tinta dentro de un rectángulo (en celdas; fin exclusivo). */
function tinta(m: Mascara, x0: number, y0: number, x1: number, y1: number): number {
  const s = integral(m);
  const w = m.ancho + 1;
  const c = (v: number, max: number) => Math.min(Math.max(0, v), max);
  x0 = c(Math.floor(x0), m.ancho);
  x1 = c(Math.ceil(x1), m.ancho);
  y0 = c(Math.floor(y0), m.alto);
  y1 = c(Math.ceil(y1), m.alto);
  if (x1 <= x0 || y1 <= y0) return 0;
  return s[y1 * w + x1] - s[y0 * w + x1] - s[y1 * w + x0] + s[y0 * w + x0];
}

/**
 * Dónde termina el texto (en fracción del alto), sin contar un pie de página
 * aislado (número de hoja, por ejemplo). null si la hoja está en blanco.
 */
export function finDelTexto(m: Mascara): number | null {
  const minimo = Math.max(1, Math.round(m.ancho * 0.004));
  const juntar = Math.max(1, Math.round(m.alto * 0.012));
  const bloques: { ini: number; fin: number }[] = [];
  for (let y = 0; y < m.alto; y++) {
    if (tinta(m, 0, y, m.ancho, y + 1) < minimo) continue;
    const ultimo = bloques[bloques.length - 1];
    if (ultimo && y - ultimo.fin <= juntar) ultimo.fin = y + 1;
    else bloques.push({ ini: y, fin: y + 1 });
  }
  if (!bloques.length) return null;
  if (bloques.length > 1) {
    const pie = bloques[bloques.length - 1];
    const previo = bloques[bloques.length - 2];
    if (pie.ini > m.alto * 0.85 && pie.fin - pie.ini < m.alto * 0.06 && pie.ini - previo.fin >= m.alto * 0.02) bloques.pop();
  }
  return bloques[bloques.length - 1].fin / m.alto;
}

export interface OpcionesAuto {
  /** Ancho deseado de la firma (pt). */
  anchoPt: number;
  /** Ancho / alto de la imagen de la firma. */
  aspecto: number;
  borde: BordeH;
  /** Otras firmas en la misma hoja (fracciones), para no encimarlas. */
  evitar?: Rect[];
}

export interface ResultadoAuto {
  ubic: Ubicacion;
  /** false si no hubo lugar libre y la firma puede tapar texto. */
  libre: boolean;
}

/** Tamaños que se prueban si la firma no entra (fracción del ancho deseado). */
const ESCALAS = [1, 0.82, 0.66, 0.52];
const SEPARACION = 12; // pt entre el texto y la firma
const PASO = 2; // pt

export function ubicarDebajoDelTexto(m: Mascara, hoja: Tamano, o: OpcionesAuto): ResultadoAuto {
  const ex = m.ancho / hoja.ancho;
  const ey = m.alto / hoja.alto;
  const margenLat = hoja.ancho * 0.07;
  const margenSup = Math.max(hoja.alto * 0.03, 16);
  const margenInf = Math.max(hoja.alto * 0.025, 14);
  const evitar = (o.evitar ?? []).map((r) => ({
    x0: r.u * hoja.ancho - 4,
    y0: r.v * hoja.alto - 4,
    x1: (r.u + r.w) * hoja.ancho + 4,
    y1: (r.v + r.h) * hoja.alto + 4,
  }));

  const medida = (f: number) => {
    let w = Math.min(o.anchoPt * f, hoja.ancho * 0.9);
    let h = w / o.aspecto;
    if (h > hoja.alto * 0.9) {
      h = hoja.alto * 0.9;
      w = h * o.aspecto;
    }
    return { w, h };
  };
  const xPara = (w: number) =>
    o.borde === 'izq' ? margenLat : o.borde === 'der' ? hoja.ancho - margenLat - w : (hoja.ancho - w) / 2;
  const estaLibre = (x: number, y: number, w: number, h: number) => {
    if (evitar.some((r) => x < r.x1 && x + w > r.x0 && y < r.y1 && y + h > r.y0)) return false;
    const area = w * ex * h * ey;
    // Con un pequeño respiro alrededor para no quedar pegada al texto.
    return tinta(m, (x - 3) * ex, (y - 4) * ey, (x + w + 3) * ex, (y + h + 4) * ey) <= Math.max(1, area * 0.002);
  };
  const resultado = (x: number, y: number, w: number): ResultadoAuto => ({
    ubic: {
      anchoPt: w,
      h:
        o.borde === 'izq'
          ? { borde: 'izq', margen: x }
          : o.borde === 'der'
            ? { borde: 'der', margen: hoja.ancho - x - w }
            : { borde: 'centro', margen: x + w / 2 - hoja.ancho / 2 },
      v: { borde: 'arriba', margen: y },
    },
    libre: true,
  });

  const fin = finDelTexto(m);
  if (fin === null) {
    // Hoja en blanco: abajo, como siempre.
    const { w } = medida(1);
    return { ubic: ubicacionAbajo(o.borde, w, hoja), libre: true };
  }

  // 1) Justo debajo de donde termina el texto (más chica si hace falta).
  const desde = Math.max(margenSup, fin * hoja.alto + SEPARACION);
  for (const f of ESCALAS) {
    const { w, h } = medida(f);
    const x = xPara(w);
    for (let y = desde; y + h <= hoja.alto - margenInf; y += PASO) if (estaLibre(x, y, w, h)) return resultado(x, y, w);
  }
  // 2) Cualquier lugar libre, empezando desde abajo (más abajo aunque sea más chica).
  const medidas = ESCALAS.map(medida);
  const minimo = Math.min(...medidas.map((m) => m.h));
  for (let base = hoja.alto - margenInf; base - minimo >= margenSup; base -= PASO) {
    for (const { w, h } of medidas) {
      const y = base - h;
      if (y >= margenSup && estaLibre(xPara(w), y, w, h)) return resultado(xPara(w), y, w);
    }
  }
  // 3) No hay lugar: abajo, avisando que puede tapar texto.
  return { ubic: ubicacionAbajo(o.borde, medida(1).w, hoja), libre: false };
}
