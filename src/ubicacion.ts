/**
 * Geometría de la firma sobre la hoja.
 *
 * La ubicación se guarda anclada a los bordes de la hoja "tal como se ve"
 * (con la rotación aplicada) y con medidas en puntos PDF. Así la firma queda
 * igual en hojas de distinto tamaño (A4, oficio, apaisadas) y, si el texto
 * de abajo crece, se mantiene pegada al borde elegido.
 */

/** Rectángulo en fracciones de la hoja visible: izquierda, arriba, ancho y alto (0 a 1). */
export interface Rect {
  u: number;
  v: number;
  w: number;
  h: number;
}

export type BordeH = 'izq' | 'centro' | 'der';
export type BordeV = 'arriba' | 'centro' | 'abajo';

export interface Ubicacion {
  /** Ancho de la firma en puntos PDF (72 pt = 2,54 cm). */
  anchoPt: number;
  /** Borde horizontal de referencia y distancia (pt). Para "centro", desplazamiento desde el centro. */
  h: { borde: BordeH; margen: number };
  v: { borde: BordeV; margen: number };
}

export interface Tamano {
  ancho: number;
  alto: number;
}

/** Caja visible de la página en el espacio de usuario PDF (CropBox). */
export interface Caja {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Parámetros para `page.drawImage` de pdf-lib. */
export interface Colocacion {
  x: number;
  y: number;
  width: number;
  height: number;
  rotate: 0 | 90 | 180 | 270;
}

/** Máxima fracción de la hoja que puede ocupar la firma. */
const MAXIMO = 0.96;
/** Tolerancia (fracción del ancho) para considerar que la firma está centrada. */
const TOLERANCIA_CENTRO = 0.08;
/** Franja inferior de la hoja (fracción) donde la firma queda anclada al pie. */
const PIE = 0.12;

export function normalizarRotacion(grados: number): 0 | 90 | 180 | 270 {
  const r = (((Math.round(grados / 90) * 90) % 360) + 360) % 360;
  return r as 0 | 90 | 180 | 270;
}

/** Tamaño de la hoja tal como se ve (si está girada 90° o 270°, se invierten ancho y alto). */
export function tamanoVisible(caja: Pick<Caja, 'width' | 'height'>, rotacion: number): Tamano {
  const r = normalizarRotacion(rotacion);
  return r === 90 || r === 270 ? { ancho: caja.height, alto: caja.width } : { ancho: caja.width, alto: caja.height };
}

const limitar = (n: number, min: number, max: number) => Math.min(Math.max(n, min), Math.max(min, max));

/**
 * Rectángulo (en fracciones) que ocupa la firma en una hoja de tamaño visible `hoja`.
 * `aspecto` = ancho / alto de la imagen de la firma.
 */
export function ubicarEnHoja(ubic: Ubicacion, hoja: Tamano, aspecto: number): Rect {
  let w = Math.min(ubic.anchoPt, hoja.ancho * MAXIMO);
  let h = w / aspecto;
  if (h > hoja.alto * MAXIMO) {
    h = hoja.alto * MAXIMO;
    w = h * aspecto;
  }
  let x: number;
  if (ubic.h.borde === 'izq') x = ubic.h.margen;
  else if (ubic.h.borde === 'der') x = hoja.ancho - ubic.h.margen - w;
  else x = (hoja.ancho - w) / 2 + ubic.h.margen;
  let y: number;
  if (ubic.v.borde === 'arriba') y = ubic.v.margen;
  else if (ubic.v.borde === 'abajo') y = hoja.alto - ubic.v.margen - h;
  else y = (hoja.alto - h) / 2 + ubic.v.margen;
  x = limitar(x, 0, hoja.ancho - w);
  y = limitar(y, 0, hoja.alto - h);
  return { u: x / hoja.ancho, v: y / hoja.alto, w: w / hoja.ancho, h: h / hoja.alto };
}

/** Inverso de `ubicarEnHoja`: a partir de dónde quedó la firma en una hoja, la ubicación anclada al borde más cercano. */
export function ubicacionDesdeRect(rect: Rect, hoja: Tamano): Ubicacion {
  const x = rect.u * hoja.ancho;
  const y = rect.v * hoja.alto;
  const w = rect.w * hoja.ancho;
  const h = rect.h * hoja.alto;
  const cx = rect.u + rect.w / 2;
  const horizontal: Ubicacion['h'] =
    Math.abs(cx - 0.5) < TOLERANCIA_CENTRO
      ? { borde: 'centro', margen: (cx - 0.5) * hoja.ancho }
      : cx < 0.5
        ? { borde: 'izq', margen: x }
        : { borde: 'der', margen: hoja.ancho - x - w };
  // Verticalmente queda fijo el borde de arriba (si crece el texto, la firma
  // crece hacia abajo y no tapa lo que está encima), salvo pegada al pie.
  const vertical: Ubicacion['v'] =
    rect.v + rect.h > 1 - PIE ? { borde: 'abajo', margen: hoja.alto - y - h } : { borde: 'arriba', margen: y };
  return { anchoPt: w, h: horizontal, v: vertical };
}

/** Ubicaciones rápidas: abajo a la izquierda, al centro o a la derecha. */
export function ubicacionAbajo(borde: BordeH, anchoPt: number, hoja: Tamano): Ubicacion {
  const margenH = Math.round(hoja.ancho * 0.07);
  const margenV = Math.round(hoja.alto * 0.05);
  return { anchoPt, h: { borde, margen: borde === 'centro' ? 0 : margenH }, v: { borde: 'abajo', margen: margenV } };
}

/**
 * Convierte un rectángulo de la hoja visible al espacio de usuario PDF,
 * con el giro necesario para que la firma se vea derecha en hojas rotadas.
 */
export function aCoordenadasPdf(caja: Caja, rotacion: number, rect: Rect): Colocacion {
  const r = normalizarRotacion(rotacion);
  const { x: cx, y: cy, width: cw, height: ch } = caja;
  const { u, v, w, h } = rect;
  switch (r) {
    case 0:
      return { x: cx + u * cw, y: cy + ch * (1 - v - h), width: w * cw, height: h * ch, rotate: 0 };
    case 90:
      // Se ve: ancho = alto de la caja. Derecha visible = +y; abajo visible = +x.
      return { x: cx + (v + h) * cw, y: cy + u * ch, width: w * ch, height: h * cw, rotate: 90 };
    case 180:
      return { x: cx + cw * (1 - u), y: cy + (v + h) * ch, width: w * cw, height: h * ch, rotate: 180 };
    case 270:
      return { x: cx + cw * (1 - v - h), y: cy + ch * (1 - u), width: w * ch, height: h * cw, rotate: 270 };
  }
}
