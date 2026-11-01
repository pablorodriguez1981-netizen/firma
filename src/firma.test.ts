import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFDict, degrees } from 'pdf-lib';
import {
  aCoordenadasPdf,
  tamanoVisible,
  ubicacionAbajo,
  ubicacionDesdeRect,
  ubicarEnHoja,
  type Caja,
  type Rect,
} from './ubicacion';
import { estamparFirmas, leerInfoPdf, tieneFirmasDigitales } from './estampar';
import { finDelTexto, mascaraDesdePixeles, ubicarDebajoDelTexto, type Mascara } from './autoubicar';
import { crc32, crearZip } from './zip';
import { LinkInvalidoError, cifrarDocumento, cifrarTexto, descifrarDocumento, descifrarTexto, generarClave, generarId } from './cifrado';
import { claveDeEnlace, crearEnlace, leerEnlace, repoDatosPredeterminado, rutaDocumento, rutaFirmado } from './enlace';
import { leyendaDeFirma } from './imagen';

/** Transformación de pdf.js (PageViewport) de espacio PDF a la hoja visible, en puntos, con origen arriba a la izquierda. */
function aVista(caja: Caja, rot: number, x: number, y: number): [number, number] {
  const { x: cx, y: cy, width: cw, height: ch } = caja;
  switch (rot) {
    case 0:
      return [x - cx, cy + ch - y];
    case 90:
      return [y - cy, x - cx];
    case 180:
      return [cx + cw - x, y - cy];
    default:
      return [cy + ch - y, cx + cw - x];
  }
}

/** Esquinas de la imagen dibujada por pdf-lib (traslación + rotación antihoraria + escala). */
function esquinasImagen(c: ReturnType<typeof aCoordenadasPdf>): [number, number][] {
  const t = (c.rotate * Math.PI) / 180;
  const ex = [Math.cos(t), Math.sin(t)];
  const ey = [-Math.sin(t), Math.cos(t)];
  return [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ].map(([a, b]) => [c.x + a * c.width * ex[0] + b * c.height * ey[0], c.y + a * c.width * ex[1] + b * c.height * ey[1]]);
}

describe('ubicación de la firma', () => {
  const caja: Caja = { x: 10, y: 20, width: 595, height: 842 };

  for (const rot of [0, 90, 180, 270]) {
    it(`se ve derecha y en su lugar con la hoja girada ${rot}°`, () => {
      const vis = tamanoVisible(caja, rot);
      const rect: Rect = { u: 0.55, v: 0.7, w: 0.35, h: 0.12 };
      const c = aCoordenadasPdf(caja, rot, rect);
      const vista = esquinasImagen(c).map(([x, y]) => aVista(caja, rot, x, y));
      // (0,0) de la imagen = abajo a la izquierda de la firma tal como se ve.
      const [abIzq, abDer, arIzq] = vista;
      const izq = rect.u * vis.ancho;
      const der = (rect.u + rect.w) * vis.ancho;
      const arriba = rect.v * vis.alto;
      const abajo = (rect.v + rect.h) * vis.alto;
      expect(abIzq[0]).toBeCloseTo(izq);
      expect(abIzq[1]).toBeCloseTo(abajo);
      expect(abDer[0]).toBeCloseTo(der);
      expect(abDer[1]).toBeCloseTo(abajo);
      expect(arIzq[0]).toBeCloseTo(izq);
      expect(arIzq[1]).toBeCloseTo(arriba);
    });
  }

  it('las hojas giradas 90° se ven apaisadas', () => {
    expect(tamanoVisible(caja, 90)).toEqual({ ancho: 842, alto: 595 });
    expect(tamanoVisible(caja, -90)).toEqual({ ancho: 842, alto: 595 });
    expect(tamanoVisible(caja, 540)).toEqual({ ancho: 595, alto: 842 });
  });

  it('mantiene el mismo tamaño y los márgenes en hojas distintas', () => {
    const a4 = { ancho: 595, alto: 842 };
    const oficio = { ancho: 612, alto: 1008 };
    const ubic = ubicacionAbajo('der', 200, a4);
    const r1 = ubicarEnHoja(ubic, a4, 2);
    const r2 = ubicarEnHoja(ubic, oficio, 2);
    expect(r1.w * a4.ancho).toBeCloseTo(200);
    expect(r2.w * oficio.ancho).toBeCloseTo(200);
    // Margen derecho e inferior iguales (en puntos).
    expect((1 - r1.u - r1.w) * a4.ancho).toBeCloseTo((1 - r2.u - r2.w) * oficio.ancho);
    expect((1 - r1.v - r1.h) * a4.alto).toBeCloseTo((1 - r2.v - r2.h) * oficio.alto);
  });

  it('si crece el texto, la firma sigue pegada abajo', () => {
    const a4 = { ancho: 595, alto: 842 };
    const ubic = ubicacionAbajo('izq', 200, a4);
    const corta = ubicarEnHoja(ubic, a4, 3);
    const larga = ubicarEnHoja(ubic, a4, 1);
    expect(corta.v + corta.h).toBeCloseTo(larga.v + larga.h);
    expect(larga.h).toBeGreaterThan(corta.h);
  });

  it('nunca se sale de la hoja', () => {
    const hoja = { ancho: 300, alto: 200 };
    const r = ubicarEnHoja({ anchoPt: 1000, h: { borde: 'der', margen: -50 }, v: { borde: 'abajo', margen: -50 } }, hoja, 1);
    expect(r.u).toBeGreaterThanOrEqual(0);
    expect(r.v).toBeGreaterThanOrEqual(0);
    expect(r.u + r.w).toBeLessThanOrEqual(1 + 1e-9);
    expect(r.v + r.h).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('arrastrar y volver a ubicar da el mismo lugar', () => {
    const hoja = { ancho: 595, alto: 842 };
    for (const rect of [
      { u: 0.05, v: 0.06, w: 0.3, h: 0.1 },
      { u: 0.33, v: 0.45, w: 0.34, h: 0.1 },
      { u: 0.6, v: 0.8, w: 0.35, h: 0.12 },
    ]) {
      const ubic = ubicacionDesdeRect(rect, hoja);
      const vuelta = ubicarEnHoja(ubic, hoja, (rect.w * hoja.ancho) / (rect.h * hoja.alto));
      expect(vuelta.u).toBeCloseTo(rect.u);
      expect(vuelta.v).toBeCloseTo(rect.v);
      expect(vuelta.w).toBeCloseTo(rect.w);
      expect(vuelta.h).toBeCloseTo(rect.h);
    }
  });
});

// PNG de 2×1 píxeles.
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGM4wcDwn4HhRAMADVQDEKtTJIQAAAAASUVORK5CYII='),
  (c) => c.charCodeAt(0),
);

async function pdfDePrueba(rotaciones: number[]) {
  const doc = await PDFDocument.create();
  doc.setTitle('Poder especial');
  for (const r of rotaciones) {
    const p = doc.addPage([595, 842]);
    p.drawText('Texto de la hoja', { x: 50, y: 800 });
    p.setRotation(degrees(r));
  }
  return doc.save();
}

function imagenesDeHoja(doc: PDFDocument, i: number): number {
  const recursos = doc.getPage(i).node.Resources();
  const xobj = recursos?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  return xobj ? xobj.keys().length : 0;
}

describe('estampar las firmas en el PDF', () => {
  it('firma una sola hoja', async () => {
    const pdf = await pdfDePrueba([0, 0, 0]);
    const ubicacion = ubicacionAbajo('der', 200, { ancho: 595, alto: 842 });
    const firmado = await estamparFirmas(pdf, [{ hoja: 3, png: PNG, aspecto: 2, ubicacion }]);
    const doc = await PDFDocument.load(firmado);
    expect(doc.getPageCount()).toBe(3);
    expect([0, 1, 2].map((i) => imagenesDeHoja(doc, i))).toEqual([0, 0, 1]);
    expect(doc.getTitle()).toBe('Poder especial');
  });

  it('una firma distinta en cada hoja, también en las giradas', async () => {
    const pdf = await pdfDePrueba([0, 90, 180, 270]);
    const ubicacion = ubicacionAbajo('centro', 180, { ancho: 595, alto: 842 });
    const firmas = [1, 2, 3, 4].map((hoja) => ({ hoja, png: PNG.slice(), aspecto: 2, ubicacion }));
    const firmado = await estamparFirmas(pdf, firmas);
    const doc = await PDFDocument.load(firmado);
    expect([0, 1, 2, 3].map((i) => imagenesDeHoja(doc, i))).toEqual([1, 1, 1, 1]);
    // Cada hoja tiene su propia imagen (no la misma repetida).
    const refs = [0, 1, 2, 3].map((i) => {
      const x = doc.getPage(i).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
      return String(x.get(x.keys()[0]));
    });
    expect(new Set(refs).size).toBe(4);
    const info = await leerInfoPdf(firmado);
    expect(info.hojas[1]).toEqual({ ancho: 842, alto: 595 });
    expect(info.firmasDigitales).toBe(false);
  });

  it('varias firmas en la misma hoja', async () => {
    const pdf = await pdfDePrueba([0, 0]);
    const hoja = { ancho: 595, alto: 842 };
    const firmado = await estamparFirmas(pdf, [
      { hoja: 2, png: PNG, aspecto: 2, ubicacion: ubicacionAbajo('izq', 150, hoja) },
      { hoja: 2, png: PNG.slice(), aspecto: 2, ubicacion: ubicacionAbajo('der', 150, hoja) },
    ]);
    const doc = await PDFDocument.load(firmado);
    expect([0, 1].map((i) => imagenesDeHoja(doc, i))).toEqual([0, 2]);
  });

  it('detecta firmas digitales previas', () => {
    expect(tieneFirmasDigitales(new TextEncoder().encode('<< /Type /Sig /ByteRange [0 1 2 3] >>'))).toBe(true);
    expect(tieneFirmasDigitales(new TextEncoder().encode('%PDF-1.7'))).toBe(false);
  });
});

/** Hoja de prueba (240 × 340 celdas, A4) con renglones de texto entre `desde` y `hasta` (fracciones). */
function hojaConTexto(desde: number, hasta: number, extra?: (m: Mascara) => void): Mascara {
  const ancho = 240;
  const alto = 340;
  const datos = new Uint8Array(ancho * alto);
  for (let y = Math.round(desde * alto); y < hasta * alto; y += 5) {
    for (const yy of [y, y + 1]) for (let x = 24; x < 216; x++) if (x % 7) datos[yy * ancho + x] = 1;
  }
  const m = { ancho, alto, datos };
  extra?.(m);
  return m;
}

describe('ubicación automática debajo del texto', () => {
  const a4 = { ancho: 595, alto: 842 };

  it('encuentra dónde termina el texto', () => {
    expect(finDelTexto(hojaConTexto(0.1, 0.4))).toBeCloseTo(0.4, 1);
    expect(finDelTexto({ ancho: 10, alto: 10, datos: new Uint8Array(100) })).toBeNull();
  });

  it('no cuenta el número de hoja del pie como texto', () => {
    const m = hojaConTexto(0.1, 0.4, (m) => {
      for (let y = 320; y < 324; y++) for (let x = 115; x < 125; x++) m.datos[y * m.ancho + x] = 1;
    });
    expect(finDelTexto(m)).toBeCloseTo(0.4, 1);
  });

  it('pone la firma justo debajo del texto', () => {
    const m = hojaConTexto(0.1, 0.4);
    const { ubic, libre } = ubicarDebajoDelTexto(m, a4, { anchoPt: 190, aspecto: 1.8, borde: 'der' });
    expect(libre).toBe(true);
    const r = ubicarEnHoja(ubic, a4, 1.8);
    expect(r.v).toBeGreaterThan(0.4);
    expect(r.v).toBeLessThan(0.45);
    expect(r.w * a4.ancho).toBeCloseTo(190);
    expect(r.u + r.w).toBeCloseTo(0.93, 2);
  });

  it('si no entra debajo, la achica o busca otro lugar libre', () => {
    // Texto hasta casi el final, con un espacio libre en el medio.
    const m = hojaConTexto(0.05, 0.95, (m) => {
      for (let y = Math.round(0.45 * m.alto); y < 0.75 * m.alto; y++) m.datos.fill(0, y * m.ancho, (y + 1) * m.ancho);
    });
    const { ubic, libre } = ubicarDebajoDelTexto(m, a4, { anchoPt: 190, aspecto: 1.8, borde: 'centro' });
    expect(libre).toBe(true);
    const r = ubicarEnHoja(ubic, a4, 1.8);
    expect(r.v).toBeGreaterThan(0.44);
    expect(r.v + r.h).toBeLessThan(0.76);
  });

  it('avisa si no hay ningún lugar libre', () => {
    const { libre } = ubicarDebajoDelTexto(hojaConTexto(0.03, 0.98), a4, { anchoPt: 190, aspecto: 1.8, borde: 'der' });
    expect(libre).toBe(false);
  });

  it('no encima dos firmas en la misma hoja', () => {
    const m = hojaConTexto(0.1, 0.3);
    const primera = ubicarEnHoja(ubicarDebajoDelTexto(m, a4, { anchoPt: 190, aspecto: 1.8, borde: 'der' }).ubic, a4, 1.8);
    const segunda = ubicarEnHoja(
      ubicarDebajoDelTexto(m, a4, { anchoPt: 190, aspecto: 1.8, borde: 'der', evitar: [primera] }).ubic,
      a4,
      1.8,
    );
    expect(segunda.v).toBeGreaterThanOrEqual(primera.v + primera.h);
  });

  it('arma el mapa de tinta desde los píxeles (también con papel gris)', () => {
    const ancho = 480;
    const alto = 680;
    const rgba = new Uint8ClampedArray(ancho * alto * 4).fill(205); // papel escaneado grisáceo
    for (let y = 100; y < 104; y++) for (let x = 60; x < 400; x++) rgba.fill(40, (y * ancho + x) * 4, (y * ancho + x) * 4 + 3);
    const m = mascaraDesdePixeles(rgba, ancho, alto);
    expect(m.ancho).toBe(240);
    expect(finDelTexto(m)).toBeCloseTo(104 / 680, 2);
  });
});

describe('zip de las imágenes', () => {
  it('calcula el CRC-32 estándar', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('arma un zip con los archivos sin comprimir', () => {
    const a = new TextEncoder().encode('hola');
    const zip = crearZip([{ nombre: 'firma 1.png', datos: a }, { nombre: 'ñandú.png', datos: PNG }]);
    const v = new DataView(zip.buffer);
    expect(v.getUint32(0, true)).toBe(0x04034b50);
    expect(v.getUint32(zip.length - 22, true)).toBe(0x06054b50);
    expect(v.getUint16(zip.length - 12, true)).toBe(2);
    expect(new TextDecoder().decode(zip.subarray(30, 41))).toBe('firma 1.png');
  });
});

describe('documentos cifrados y links', () => {
  it('cifra y descifra el PDF con su cabecera', async () => {
    const pdf = await pdfDePrueba([0]);
    const clave = generarClave();
    const cab = { titulo: 'Poder', archivo: 'poder.pdf', instrucciones: 'Firmá todas las hojas', alcance: 'todas' as const, creado: '2026-11-01' };
    const cifrado = await cifrarDocumento(pdf, cab, clave);
    expect(new TextDecoder().decode(cifrado).includes('Poder')).toBe(false);
    const { cabecera, pdf: vuelta } = await descifrarDocumento(cifrado, clave);
    expect(cabecera).toEqual(cab);
    expect(vuelta).toEqual(pdf);
  });

  it('rechaza una clave equivocada o un archivo dañado', async () => {
    const cifrado = await cifrarDocumento(new Uint8Array([1, 2, 3]), { titulo: 't', archivo: 'a.pdf', creado: 'x' }, generarClave());
    await expect(descifrarDocumento(cifrado, generarClave())).rejects.toBeInstanceOf(LinkInvalidoError);
    await expect(descifrarDocumento(new Uint8Array(40), generarClave())).rejects.toBeInstanceOf(LinkInvalidoError);
  });

  it('cifra el permiso que va en el link', async () => {
    const clave = generarClave();
    const t = await cifrarTexto('github_pat_123abc', clave);
    expect(t).not.toContain('github_pat');
    expect(await descifrarTexto(t, clave)).toBe('github_pat_123abc');
    await expect(descifrarTexto(t, generarClave())).rejects.toBeInstanceOf(LinkInvalidoError);
  });

  it('arma y lee links', async () => {
    const repo = repoDatosPredeterminado({ hostname: 'estudio.github.io' });
    expect(repo).toBe('estudio/firma-datos');
    expect(repoDatosPredeterminado({ hostname: 'localhost' })).toBeNull();

    const clave = generarClave();
    const datos = { id: generarId(), clave, token: await cifrarTexto('github_pat_x', clave), repo: 'estudio/firma-datos' };
    const link = crearEnlace('https://estudio.github.io/firma/', datos, repo);
    expect(link).not.toContain('r=');
    expect(leerEnlace(new URL(link).hash, repo)).toEqual(datos);
    expect(claveDeEnlace(link)).toBe(clave);

    const otro = crearEnlace('http://localhost:5173/', { ...datos, repo: 'otro/docs' }, null);
    expect(leerEnlace(new URL(otro).hash, null)).toEqual({ ...datos, repo: 'otro/docs' });
    // Sin el permiso cifrado, el link está incompleto.
    expect(leerEnlace(`#d=${datos.id}&k=${clave}`, repo)).toBeNull();
    expect(leerEnlace('#d=zz&k=abc&t=xyz', repo)).toBeNull();
    expect(rutaDocumento('abc123')).toBe('casos/abc123.firma');
    expect(rutaFirmado('abc123')).toBe('firmados/abc123.firma');
  });

  it('cifra el documento firmado que vuelve al estudio', async () => {
    const clave = generarClave();
    const dev = { titulo: 'Poder', archivo: 'poder.pdf', datos: 'María Gómez\nDNI 28.765.432', firmas: 2, firmado: '2026-11-01' };
    const pdf = new Uint8Array([37, 80, 68, 70]);
    const { cabecera, pdf: vuelta } = await descifrarDocumento<typeof dev>(await cifrarDocumento(pdf, dev, clave), clave);
    expect(cabecera).toEqual(dev);
    expect(vuelta).toEqual(pdf);
  });

  it('aclara que está firmado digitalmente', () => {
    expect(leyendaDeFirma(null)).toBe('Firmado digitalmente');
    expect(leyendaDeFirma(new Date(2026, 10, 1, 9, 5))).toBe('Firmado digitalmente el 01/11/2026 a las 09:05 h');
  });
});

describe('hoja llena', () => {
  it('prefiere el margen de abajo (más chica) antes que arriba de todo', () => {
    const a4 = { ancho: 595, alto: 842 };
    // Título corto arriba a la izquierda, texto de 0.14 a 0.86 y número de hoja centrado abajo.
    const m = hojaConTexto(0.14, 0.86, (m) => {
      for (let y = 30; y < 34; y++) for (let x = 24; x < 120; x++) m.datos[y * m.ancho + x] = 1;
      for (let y = 326; y < 329; y++) for (let x = 110; x < 130; x++) m.datos[y * m.ancho + x] = 1;
    });
    const { ubic, libre } = ubicarDebajoDelTexto(m, a4, { anchoPt: 190, aspecto: 1.6, borde: 'der' });
    expect(libre).toBe(true);
    const r = ubicarEnHoja(ubic, a4, 1.6);
    expect(r.v).toBeGreaterThan(0.86);
    expect(r.w * a4.ancho).toBeLessThan(190);
  });
});
