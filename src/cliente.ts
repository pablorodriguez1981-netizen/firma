/**
 * Página de firma.
 *
 * Cliente: abre el PDF (desde un link del estudio o elegido del dispositivo),
 * escribe sus datos y firma a mano: una vez, una vez por hoja o donde elija.
 * Cada firma se dibuja por separado (no se repite la misma imagen) y se
 * ubica sola debajo del texto de la hoja; se puede mover y achicar.
 *
 * Estudio (#preparar): marca dónde tiene que firmar el cliente y genera el link.
 */
import SignaturePad, { type PointGroup } from 'signature_pad';
import './firma.css';
import { abrirPdf, Visor } from './visor';
import { aspectoEstimado, componerImagen, fechaDeFirma, rasterizarFirma, type ImagenFirma } from './imagen';
import { PdfProtegidoError, estamparFirmas, leerInfoPdf } from './estampar';
import { ubicacionAbajo, ubicacionDesdeRect, ubicarEnHoja, type BordeH, type Rect, type Tamano, type Ubicacion } from './ubicacion';
import { ubicarDebajoDelTexto } from './autoubicar';
import { crearEnlace, leerEnlace, repoDesdeUbicacion, rutaDocumento, urlDocumento } from './enlace';
import {
  LinkInvalidoError,
  cifrarDocumento,
  descifrarDocumento,
  generarClave,
  generarId,
  type Cabecera,
  type LugarDeFirma,
} from './cifrado';
import { agregarLink, conexion } from './almacen';
import { crearZip } from './zip';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

type Modo = 'una' | 'todas' | 'elegir';

/** Trazos normalizados: x, y y tiempo divididos por el ancho del recuadro (no dependen del tamaño de pantalla). */
type Trazos = PointGroup[];

interface Casillero {
  id: number;
  /** Hoja (base 1). */
  hoja: number;
  ubic: Ubicacion | null;
  /** La movió alguien (cliente o estudio): no se reubica sola. */
  manual: boolean;
  /** false si la ubicación automática no encontró lugar libre. */
  libre: boolean;
  trazos: Trazos;
  recorte: HTMLCanvasElement | null;
  recorteColor: string;
  imagen: ImagenFirma | null;
}

const ANCHO_INICIAL_PT = 190; // ≈ 6,7 cm
/** Proporción del recuadro de firma (ancho / alto). */
const PROPORCION_PAD = 2.5;

const estado = {
  original: null as Uint8Array | null,
  nombre: 'documento.pdf',
  desdeLink: false,
  preparar: location.hash === '#preparar',
  /** El estudio fijó cuántas firmas y en qué hojas. */
  fijo: false,
  hojas: [] as Tamano[],
  visor: null as Visor | null,
  visorFirmado: null as Visor | null,
  modo: 'una' as Modo,
  casilleros: [] as Casillero[],
  actual: 0,
  anchoPt: ANCHO_INICIAL_PT,
  borde: 'der' as BordeH,
  color: '#1b3a8a',
  firmado: null as { pdf: Uint8Array; imagenes: { hoja: number; png: Uint8Array }[] } | null,
};
let proximoId = 1;

const texto = () => $<HTMLTextAreaElement>('texto').value;
const conFecha = () => $<HTMLInputElement>('con-fecha').checked;
const actual = () => estado.casilleros[estado.actual];

/* ───────────── Utilidades ───────────── */

function mostrarError(msg: string | null) {
  const el = $('error');
  el.textContent = msg ?? '';
  el.hidden = !msg;
  if (msg) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function cargando(msg: string | null) {
  $('cargando').hidden = !msg;
  if (msg) $('cargando-texto').textContent = msg;
}

function nombreBase() {
  return estado.nombre.replace(/\.pdf$/i, '');
}

function descargar(bytes: Uint8Array, nombre: string, tipo: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: tipo }));
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function lista(nums: number[]): string {
  if (nums.length === 1) return `la ${nums[0]}`;
  return `las ${nums.slice(0, -1).join(', ')} y ${nums[nums.length - 1]}`;
}

function cm(pt: number) {
  return `${((pt / 72) * 2.54).toFixed(1).replace('.', ',')} cm`;
}

/* ───────────── Casilleros (cada firma) ───────────── */

function nuevoCasillero(hoja: number, ubic: Ubicacion | null = null, manual = false): Casillero {
  return { id: proximoId++, hoja, ubic, manual, libre: true, trazos: [], recorte: null, recorteColor: '', imagen: null };
}

function liberar(c: Casillero) {
  if (c.imagen) URL.revokeObjectURL(c.imagen.url);
  c.imagen = null;
}

function ordenar() {
  const c = actual();
  estado.casilleros.sort((a, b) => a.hoja - b.hoja);
  estado.actual = Math.max(0, estado.casilleros.indexOf(c));
}

function aspectoDe(c: Casillero): number {
  if (c.imagen) return c.imagen.aspecto;
  const otra = estado.casilleros.find((x) => x.imagen);
  if (otra?.imagen) return otra.imagen.aspecto;
  return estado.preparar ? aspectoEstimado('Nombre\nDNI\nDomicilio', true) : aspectoEstimado(texto(), conFecha());
}

function rectDe(c: Casillero): Rect | null {
  return c.ubic ? ubicarEnHoja(c.ubic, estado.hojas[c.hoja - 1], aspectoDe(c)) : null;
}

/** Cambia cuántas firmas hay. Devuelve false si el usuario no quiso perder firmas ya hechas. */
function aplicarModo(modo: Modo, preguntar = true): boolean {
  const total = estado.hojas.length;
  const antes = estado.casilleros;
  let nuevos: Casillero[];
  if (modo === 'todas') {
    nuevos = Array.from({ length: total }, (_, i) => antes.find((c) => c.hoja === i + 1) ?? nuevoCasillero(i + 1));
  } else if (modo === 'una') {
    nuevos = [antes.find((c) => c.trazos.length) ?? antes.find((c) => c.hoja === total) ?? antes[0] ?? nuevoCasillero(total)];
  } else {
    nuevos = antes.length ? antes : [nuevoCasillero(total)];
  }
  const perdidas = antes.filter((c) => c.trazos.length && !nuevos.includes(c)).length;
  if (perdidas && preguntar && !confirm(`Se ${perdidas === 1 ? 'va a borrar 1 firma ya hecha' : `van a borrar ${perdidas} firmas ya hechas`}. ¿Seguir?`)) {
    return false;
  }
  for (const c of antes) if (!nuevos.includes(c)) liberar(c);
  estado.modo = modo;
  estado.casilleros = nuevos;
  const pendiente = nuevos.findIndex((c) => !c.trazos.length);
  estado.actual = pendiente >= 0 ? pendiente : 0;
  invalidarResultado();
  cargarEnPad();
  actualizarUbicaciones();
  refrescar();
  return true;
}

function seleccionar(i: number) {
  estado.actual = Math.min(Math.max(0, i), estado.casilleros.length - 1);
  cargarEnPad();
  refrescar();
}

/* ───────────── Ubicación automática ───────────── */

const pidiendo = new Set<number>();

function pedirMascara(n: number) {
  const visor = estado.visor;
  if (!visor || pidiendo.has(n)) return;
  pidiendo.add(n);
  visor.mascara(n).then(
    () => {
      pidiendo.delete(n);
      if (estado.visor === visor) {
        actualizarUbicaciones();
        refrescar();
      }
    },
    () => pidiendo.delete(n),
  );
}

/** Ubica las firmas automáticas debajo del texto, sin encimarlas con las demás de la misma hoja. */
function actualizarUbicaciones() {
  const visor = estado.visor;
  if (!visor) return;
  const ocupados = new Map<number, Rect[]>();
  const ocupar = (c: Casillero) => {
    const r = rectDe(c);
    if (r) ocupados.set(c.hoja, [...(ocupados.get(c.hoja) ?? []), r]);
  };
  for (const c of estado.casilleros) if (c.manual) ocupar(c);
  for (const c of estado.casilleros) {
    if (c.manual) continue;
    const hoja = estado.hojas[c.hoja - 1];
    const mascara = visor.mascaraLista(c.hoja);
    if (mascara) {
      const r = ubicarDebajoDelTexto(mascara, hoja, {
        anchoPt: estado.anchoPt,
        aspecto: aspectoDe(c),
        borde: estado.borde,
        evitar: ocupados.get(c.hoja),
      });
      c.ubic = r.ubic;
      c.libre = r.libre;
    } else {
      // Provisorio hasta analizar la hoja.
      if (!c.ubic) c.ubic = ubicacionAbajo(estado.borde, estado.anchoPt, hoja);
      pedirMascara(c.hoja);
    }
    ocupar(c);
  }
}

/* ───────────── Carga del documento ───────────── */

async function abrirDesdeLink(): Promise<boolean> {
  if (!/[#&]d=/.test(location.hash)) return false;
  const datos = leerEnlace(location.hash, repoDesdeUbicacion(location));
  if (!datos || !datos.repo) {
    mostrarError('El link está incompleto. Copialo entero o pedile al estudio que te lo reenvíe.');
    return true;
  }
  estado.desdeLink = true;
  cargando('Descargando el documento…');
  try {
    let r: Response;
    try {
      r = await fetch(urlDocumento(datos.repo, datos.id), { cache: 'no-store' });
    } catch {
      throw new Error('No se pudo descargar el documento. Revisá tu conexión a internet y volvé a abrir el link.');
    }
    if (r.status === 404) throw new Error('Este documento ya no está disponible. Pedile al estudio que te mande un link nuevo.');
    if (!r.ok) throw new Error(`No se pudo descargar el documento (error ${r.status}). Probá de nuevo en un rato.`);
    cargando('Abriendo el documento…');
    const { cabecera, pdf } = await descifrarDocumento(new Uint8Array(await r.arrayBuffer()), datos.clave);
    aplicarCabecera(cabecera);
    await cargarPdf(pdf, cabecera.archivo || 'documento.pdf', cabecera);
  } catch (e) {
    mostrarError(
      e instanceof LinkInvalidoError
        ? 'El link está incompleto o el documento está dañado. Pedile al estudio que te lo reenvíe.'
        : e instanceof Error
          ? e.message
          : 'No se pudo abrir el documento.',
    );
  } finally {
    cargando(null);
  }
  return true;
}

function aplicarCabecera(c: Cabecera) {
  const titulo = c.titulo || c.archivo;
  $('titulo').textContent = titulo ? `Firmá: ${titulo}` : 'Firmá tu documento';
  if (titulo) document.title = `Firmar · ${titulo}`;
  if (c.instrucciones?.trim()) {
    $('instrucciones-texto').textContent = c.instrucciones.trim();
    $('instrucciones').hidden = false;
  }
}

const BORDES_H = ['izq', 'centro', 'der'];
const BORDES_V = ['arriba', 'centro', 'abajo'];

function ubicacionValida(u: unknown): u is Ubicacion {
  const x = u as Ubicacion;
  return (
    !!x &&
    Number.isFinite(x.anchoPt) &&
    x.anchoPt > 10 &&
    BORDES_H.includes(x.h?.borde) &&
    Number.isFinite(x.h?.margen) &&
    BORDES_V.includes(x.v?.borde) &&
    Number.isFinite(x.v?.margen)
  );
}

function casillerosIniciales(cabecera: Cabecera | undefined, total: number) {
  const lugares = (cabecera?.firmas ?? []).filter(
    (l) => Number.isInteger(l.hoja) && l.hoja >= 1 && l.hoja <= total && ubicacionValida(l.ubic),
  );
  if (lugares.length) {
    estado.casilleros = lugares.map((l) => nuevoCasillero(l.hoja, l.ubic, true));
    ordenar();
    const unaPorHoja = lugares.length === total && new Set(lugares.map((l) => l.hoja)).size === total;
    estado.modo = lugares.length === 1 ? 'una' : unaPorHoja ? 'todas' : 'elegir';
    estado.fijo = !!cabecera?.fijo;
    estado.anchoPt = lugares[0].ubic.anchoPt;
    return;
  }
  estado.fijo = false;
  estado.modo = cabecera?.alcance === 'todas' && total > 1 ? 'todas' : 'una';
  estado.casilleros = [];
  aplicarModo(estado.modo, false);
}

async function cargarPdf(bytes: Uint8Array, nombre: string, cabecera?: Cabecera) {
  mostrarError(null);
  let info;
  try {
    info = await leerInfoPdf(bytes);
  } catch (e) {
    throw new Error(
      e instanceof PdfProtegidoError
        ? 'Este PDF está protegido (con contraseña o contra cambios) y no se puede firmar. Hace falta una versión sin protección.'
        : 'No se pudo leer el archivo. ¿Es un PDF válido?',
    );
  }
  if (!info.hojas.length) throw new Error('El PDF no tiene hojas.');
  const doc = await abrirPdf(bytes);
  await estado.visor?.cerrar();
  await descartarFirmado();
  for (const c of estado.casilleros) liberar(c);
  estado.casilleros = [];
  estado.original = bytes;
  estado.nombre = nombre;
  estado.hojas = info.hojas;
  $('trabajo').hidden = false;
  $('elegir').hidden = true;
  const ancho = Math.max($('hojas').clientWidth || 600, 320);
  estado.visor = new Visor(doc, Math.min(1600, ancho * Math.min(window.devicePixelRatio || 1, 2)));
  const total = info.hojas.length;

  $('cambiar').hidden = estado.desdeLink;
  $('doc-nombre').textContent = nombre;
  $('doc-hojas').textContent = total === 1 ? '1 hoja' : `${total} hojas`;
  $('aviso-firmas-digitales').hidden = !info.firmasDigitales;
  $('modo-todas-detalle').textContent = total === 1 ? 'El documento tiene 1 hoja' : `${total} firmas, una por hoja`;
  $<HTMLSelectElement>('cas-hoja').replaceChildren(
    ...info.hojas.map((_, i) => {
      const o = document.createElement('option');
      o.value = String(i + 1);
      o.textContent = `Hoja ${i + 1} de ${total}`;
      return o;
    }),
  );
  if (estado.preparar) $<HTMLInputElement>('env-titulo').value = nombre.replace(/\.pdf$/i, '');

  casillerosIniciales(cabecera, total);
  armarHojas(estado.visor, true);
  ajustarPad();
  cargarEnPad();
  actualizarUbicaciones();
  refrescar();
}

/* ───────────── Capas de firma sobre una hoja ───────────── */

/** Sincroniza los recuadros de firma de una hoja (los reutiliza para no cortar un arrastre). */
function sincronizarCapas(cont: HTMLElement, hoja: number, editable: boolean) {
  const presentes = new Set<string>();
  estado.casilleros.forEach((c, i) => {
    if (c.hoja !== hoja || !c.ubic) return;
    const clave = String(c.id);
    presentes.add(clave);
    let el = cont.querySelector<HTMLElement>(`:scope > [data-id="${clave}"]`);
    if (!el) {
      el = document.createElement('div');
      el.dataset.id = clave;
      el.className = 'capa-firma';
      el.append(document.createElement('img'), document.createElement('span'));
      el.querySelector('img')!.alt = '';
      el.querySelector('img')!.draggable = false;
      cont.append(el);
    }
    el.dataset.idx = String(i);
    const r = rectDe(c)!;
    el.style.left = `${r.u * 100}%`;
    el.style.top = `${r.v * 100}%`;
    el.style.width = `${r.w * 100}%`;
    el.style.height = `${r.h * 100}%`;
    const img = el.querySelector('img')!;
    const etiqueta = el.querySelector('span')!;
    if (c.imagen) {
      if (img.src !== c.imagen.url) img.src = c.imagen.url;
    } else img.removeAttribute('src');
    const varias = estado.casilleros.length > 1;
    etiqueta.textContent = estado.preparar ? `Firma ${i + 1}` : varias ? `Firma ${i + 1}` : 'Tu firma';
    el.classList.toggle('vacia', !c.imagen);
    el.classList.toggle('actual', i === estado.actual);
    el.classList.toggle('alerta', !c.libre && !c.manual);
    el.classList.toggle('editable', editable);
    el.title = varias ? `Firma ${i + 1} · hoja ${c.hoja}` : `Firma · hoja ${c.hoja}`;
  });
  cont.querySelectorAll<HTMLElement>(':scope > .capa-firma').forEach((el) => {
    if (!presentes.has(el.dataset.id!)) el.remove();
  });
}

/* ───────────── Vista del documento ───────────── */

let observador: IntersectionObserver | null = null;

function armarHojas(visor: Visor, conFirmas: boolean) {
  const cont = $('hojas');
  observador?.disconnect();
  cont.replaceChildren();
  cont.classList.toggle('con-firmas', conFirmas);
  const pedir = (n: number) => {
    const el = cont.querySelector<HTMLElement>(`[data-hoja="${n}"]`);
    const img = el?.querySelector<HTMLImageElement>('.hoja-img');
    if (!img || img.dataset.pedida) return;
    img.dataset.pedida = '1';
    visor.imagen(n).then(
      (url) => {
        img.src = url;
      },
      () => el?.classList.add('hoja-falla'),
    );
  };
  observador = new IntersectionObserver(
    (entradas) => {
      for (const e of entradas) {
        if (!e.isIntersecting) continue;
        const n = Number((e.target as HTMLElement).dataset.hoja);
        pedir(n);
        if (n < estado.hojas.length) pedir(n + 1);
        observador?.unobserve(e.target);
      }
    },
    { rootMargin: '600px 0px' },
  );
  estado.hojas.forEach((t, i) => {
    const n = i + 1;
    const hoja = document.createElement('div');
    hoja.className = 'hoja';
    hoja.dataset.hoja = String(n);
    const lienzo = document.createElement('div');
    lienzo.className = 'hoja-lienzo';
    lienzo.style.aspectRatio = `${t.ancho} / ${t.alto}`;
    const img = document.createElement('img');
    img.className = 'hoja-img';
    img.alt = `Hoja ${n}`;
    lienzo.append(img);
    const pie = document.createElement('div');
    pie.className = 'hoja-pie';
    const num = document.createElement('span');
    num.textContent = `Hoja ${n} de ${estado.hojas.length}`;
    pie.append(num);
    if (conFirmas) {
      const marca = document.createElement('span');
      marca.className = 'hoja-marca';
      const mover = document.createElement('button');
      mover.type = 'button';
      mover.className = 'boton chico hoja-mover';
      mover.textContent = 'Firmar en esta hoja';
      mover.addEventListener('click', () => {
        const c = actual();
        if (!c) return;
        c.hoja = n;
        c.manual = false;
        c.ubic = null;
        invalidarResultado();
        actualizarUbicaciones();
        refrescar();
        $('paso-firmas').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      const agregar = document.createElement('button');
      agregar.type = 'button';
      agregar.className = 'boton chico hoja-agregar';
      agregar.textContent = '＋ Firma acá';
      agregar.addEventListener('click', () => agregarCasillero(n));
      pie.append(marca, mover, agregar);
      lienzo.addEventListener('click', (e) => {
        const capa = (e.target as HTMLElement).closest<HTMLElement>('.capa-firma');
        if (!capa) return;
        seleccionar(Number(capa.dataset.idx));
        $('paso-firmas').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
    hoja.append(lienzo, pie);
    cont.append(hoja);
    observador!.observe(hoja);
  });
}

function actualizarHojas() {
  if (estado.firmado) return;
  const fijo = estado.fijo;
  document.querySelectorAll<HTMLElement>('#hojas .hoja').forEach((hoja) => {
    const n = Number(hoja.dataset.hoja);
    const lienzo = hoja.querySelector<HTMLElement>('.hoja-lienzo')!;
    sincronizarCapas(lienzo, n, false);
    const cuantas = estado.casilleros.filter((c) => c.hoja === n).length;
    hoja.classList.toggle('elegida', cuantas > 0);
    const marca = hoja.querySelector<HTMLElement>('.hoja-marca');
    if (marca) marca.textContent = cuantas ? `✍️ ${cuantas === 1 ? '1 firma' : `${cuantas} firmas`}` : '';
    const mover = hoja.querySelector<HTMLElement>('.hoja-mover');
    if (mover) mover.hidden = fijo || estado.modo !== 'una' || cuantas > 0;
    const agregar = hoja.querySelector<HTMLElement>('.hoja-agregar');
    if (agregar) agregar.hidden = fijo || estado.modo !== 'elegir';
  });
}

/* ───────────── Pantalla: firmas y editor ───────────── */

/** Hoja (y visor) que muestra el editor. */
let edHoja = 0;
let edVisor: Visor | null = null;

function refrescar() {
  if (!estado.visor || !estado.casilleros.length) return;
  const n = estado.casilleros.length;
  const c = actual();
  const k = estado.actual + 1;
  const hechas = estado.casilleros.filter((x) => x.trazos.length).length;
  const total = estado.hojas.length;

  // Modo
  $('modos').hidden = estado.fijo;
  document.querySelectorAll<HTMLInputElement>('input[name=modo]').forEach((r) => {
    r.checked = r.value === estado.modo;
    r.disabled = r.value === 'todas' && total === 1;
  });
  let resumen: string;
  if (estado.preparar) {
    resumen =
      n === 1
        ? `El cliente va a firmar una vez, en la hoja ${c.hoja}.`
        : `El cliente va a firmar ${n} veces${estado.modo === 'todas' ? ', una en cada hoja' : ''}.`;
  } else if (estado.fijo) {
    resumen = n === 1 ? `El estudio marcó dónde firmar (hoja ${c.hoja}).` : `El estudio marcó ${n} lugares para firmar. Firmá en cada uno.`;
  } else {
    resumen =
      n === 1
        ? `Vas a firmar una vez, en la hoja ${c.hoja}.`
        : `Vas a firmar ${n} veces${estado.modo === 'todas' ? ', una en cada hoja' : ''}: cada firma se hace por separado.`;
  }
  if (!estado.preparar && n > 1) resumen += ` Llevás ${hechas} de ${n}.`;
  $('resumen').textContent = resumen;

  // Fichas (una por firma)
  const fichas = $('fichas');
  fichas.hidden = n === 1;
  if (fichas.children.length !== n) {
    fichas.replaceChildren(
      ...estado.casilleros.map((_, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ficha';
        b.addEventListener('click', () => seleccionar(i));
        return b;
      }),
    );
  }
  estado.casilleros.forEach((x, i) => {
    const b = fichas.children[i] as HTMLButtonElement;
    b.textContent = !estado.preparar && x.trazos.length ? `✓ ${i + 1}` : String(i + 1);
    b.title = `Firma ${i + 1} · hoja ${x.hoja}`;
    b.classList.toggle('hecha', !estado.preparar && x.trazos.length > 0);
    b.classList.toggle('actual', i === estado.actual);
    b.classList.toggle('alerta', !x.libre && !x.manual);
    b.setAttribute('aria-current', String(i === estado.actual));
  });
  (fichas.children[estado.actual] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });

  // Cabecera de la firma actual
  $('cas-titulo').textContent = n === 1 ? 'Firma' : `Firma ${k} de ${n}`;
  const sel = $<HTMLSelectElement>('cas-hoja');
  const hojaElegible = !estado.fijo && estado.modo !== 'todas';
  sel.hidden = !hojaElegible;
  sel.value = String(c.hoja);
  $('cas-hoja-fija').hidden = hojaElegible;
  $('cas-hoja-fija').textContent = `· hoja ${c.hoja} de ${total}`;
  $<HTMLButtonElement>('cas-ant').hidden = $<HTMLButtonElement>('cas-sig').hidden = n === 1;
  $<HTMLButtonElement>('cas-ant').disabled = estado.actual === 0;
  $<HTMLButtonElement>('cas-sig').disabled = estado.actual === n - 1;

  // Editor de la hoja de esta firma
  const t = estado.hojas[c.hoja - 1];
  const editor = $('editor-hoja');
  editor.style.aspectRatio = `${t.ancho} / ${t.alto}`;
  editor.style.width = `min(100%, ${(58 * t.ancho) / t.alto}vh)`;
  const img = $<HTMLImageElement>('ed-img');
  if (edHoja !== c.hoja || edVisor !== estado.visor) {
    edHoja = c.hoja;
    edVisor = estado.visor;
    img.removeAttribute('src');
    const visor = estado.visor;
    const hoja = c.hoja;
    visor.imagen(hoja).then(
      (url) => {
        if (edHoja === hoja && edVisor === visor) img.src = url;
      },
      () => undefined,
    );
  }
  sincronizarCapas($('ed-capas'), c.hoja, true);
  $('aviso-tapa').hidden = c.libre || c.manual;

  const rango = $<HTMLInputElement>('tamano');
  const r = rectDe(c);
  const anchoReal = r ? r.w * t.ancho : estado.anchoPt;
  rango.max = String(Math.round(Math.min(420, t.ancho * 0.9)));
  rango.value = String(Math.round(anchoReal));
  $('tamano-cm').textContent = cm(anchoReal);
  document.querySelectorAll<HTMLButtonElement>('.rapidos [data-pos]').forEach((b) =>
    b.classList.toggle('activo', !c.manual && b.dataset.pos === estado.borde),
  );

  $('acciones-elegir').hidden = estado.fijo || estado.modo !== 'elegir';
  $<HTMLButtonElement>('quitar').disabled = n === 1;

  // Recuadro de firma
  const titulo = n === 1 ? 'Firmá acá' : `Firma ${k} de ${n} · va en la hoja ${c.hoja}`;
  $('pad-titulo').textContent = titulo;
  $('pf-titulo').textContent = titulo;
  const ultima = estado.actual === n - 1;
  $('siguiente').hidden = $('pista-enter').hidden = n === 1;
  $('siguiente').textContent = ultima ? 'Listo ✓' : 'Siguiente firma ›';
  $('pf-sig').textContent = ultima ? 'Listo ✓' : 'Siguiente firma ›';
  $('pf-ant').hidden = n === 1;
  $<HTMLButtonElement>('pf-ant').disabled = estado.actual === 0;

  // Paso final
  $('descargar-imagen').textContent = n === 1 ? 'Descargar la firma como imagen' : 'Descargar las firmas como imágenes (ZIP)';
  actualizarHojas();
}

function agregarCasillero(hoja: number) {
  const c = nuevoCasillero(hoja);
  estado.casilleros.splice(estado.actual + 1, 0, c);
  estado.actual = estado.casilleros.indexOf(c);
  ordenar();
  invalidarResultado();
  cargarEnPad();
  actualizarUbicaciones();
  refrescar();
  $('paso-firmas').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function moverA(c: Casillero, rect: Rect) {
  const t = estado.hojas[c.hoja - 1];
  rect.u = Math.min(Math.max(0, rect.u), 1 - rect.w);
  rect.v = Math.min(Math.max(0, rect.v), 1 - rect.h);
  c.ubic = ubicacionDesdeRect(rect, t);
  c.manual = true;
  c.libre = true;
  invalidarResultado();
  actualizarUbicaciones();
  refrescar();
}

function prepararEditor() {
  const cont = $('editor-hoja');
  // Arrastrar una firma (sobre la firma no se desplaza la página) o tocar la hoja para llevarla ahí.
  let arrastre: { id: number; x: number; y: number; rect: Rect; c: Casillero } | null = null;
  let toque: { id: number; x: number; y: number } | null = null;
  cont.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const capa = (e.target as HTMLElement).closest<HTMLElement>('.capa-firma');
    if (capa) {
      const i = Number(capa.dataset.idx);
      if (i !== estado.actual) seleccionar(i);
      const c = actual();
      const rect = rectDe(c);
      if (!rect) return;
      arrastre = { id: e.pointerId, x: e.clientX, y: e.clientY, rect, c };
      cont.setPointerCapture(e.pointerId);
      capa.classList.add('arrastrando');
      e.preventDefault();
      return;
    }
    toque = { id: e.pointerId, x: e.clientX, y: e.clientY };
  });
  cont.addEventListener('pointermove', (e) => {
    if (!arrastre || e.pointerId !== arrastre.id) return;
    const caja = cont.getBoundingClientRect();
    moverA(arrastre.c, {
      ...arrastre.rect,
      u: arrastre.rect.u + (e.clientX - arrastre.x) / caja.width,
      v: arrastre.rect.v + (e.clientY - arrastre.y) / caja.height,
    });
  });
  const fin = (e: PointerEvent) => {
    if (arrastre && e.pointerId === arrastre.id) {
      arrastre = null;
      cont.querySelectorAll('.arrastrando').forEach((x) => x.classList.remove('arrastrando'));
      return;
    }
    const t = toque;
    toque = null;
    if (e.type !== 'pointerup' || !t || t.id !== e.pointerId || Math.hypot(e.clientX - t.x, e.clientY - t.y) > 10) return;
    const c = actual();
    const rect = c && rectDe(c);
    if (!rect) return;
    const caja = cont.getBoundingClientRect();
    moverA(c, { ...rect, u: (e.clientX - caja.left) / caja.width - rect.w / 2, v: (e.clientY - caja.top) / caja.height - rect.h / 2 });
  };
  cont.addEventListener('pointerup', fin);
  cont.addEventListener('pointercancel', fin);

  $('cas-ant').addEventListener('click', () => seleccionar(estado.actual - 1));
  $('cas-sig').addEventListener('click', () => seleccionar(estado.actual + 1));
  $('cas-hoja').addEventListener('change', (e) => {
    const c = actual();
    c.hoja = Number((e.target as HTMLSelectElement).value);
    c.manual = false;
    c.ubic = null;
    ordenar();
    invalidarResultado();
    actualizarUbicaciones();
    refrescar();
  });
  document.querySelectorAll<HTMLButtonElement>('.rapidos [data-pos]').forEach((b) =>
    b.addEventListener('click', () => {
      estado.borde = b.dataset.pos as BordeH;
      const c = actual();
      c.manual = false;
      invalidarResultado();
      actualizarUbicaciones();
      refrescar();
    }),
  );
  $('tamano').addEventListener('input', (e) => {
    const v = Number((e.target as HTMLInputElement).value);
    estado.anchoPt = v;
    for (const c of estado.casilleros) if (c.manual && c.ubic) c.ubic = { ...c.ubic, anchoPt: v };
    invalidarResultado();
    actualizarUbicaciones();
    refrescar();
  });
  $('agregar').addEventListener('click', () => agregarCasillero(actual().hoja));
  $('quitar').addEventListener('click', () => {
    if (estado.casilleros.length < 2) return;
    const c = actual();
    if (c.trazos.length && !confirm('¿Quitar esta firma? Ya está hecha.')) return;
    liberar(c);
    estado.casilleros.splice(estado.actual, 1);
    estado.actual = Math.min(estado.actual, estado.casilleros.length - 1);
    invalidarResultado();
    cargarEnPad();
    actualizarUbicaciones();
    refrescar();
  });
  document.querySelectorAll<HTMLInputElement>('input[name=modo]').forEach((r) =>
    r.addEventListener('change', () => {
      if (!r.checked) return;
      if (!aplicarModo(r.value as Modo)) refrescar();
    }),
  );
}

/* ───────────── Firma a mano ───────────── */

const lienzoPad = $<HTMLCanvasElement>('pad');
const pad = new SignaturePad(lienzoPad, { penColor: estado.color, velocityFilterWeight: 0.6, minDistance: 2 });
let anchoPad = 0;

// Lienzo de referencia (fuera de pantalla) para pasar cada firma a SVG a tamaño fijo.
const ANCHO_REF = 1000;
const lienzoRef = document.createElement('canvas');
const padRef = new SignaturePad(lienzoRef);
padRef.off();

function grosores(ancho: number) {
  const f = ancho / 560;
  return { minWidth: 0.9 * f, maxWidth: 3.1 * f };
}

function normalizar(grupos: PointGroup[], ancho: number): Trazos {
  return grupos.map((g) => {
    const t0 = g.points[0]?.time ?? 0;
    return { ...g, points: g.points.map((p) => ({ x: p.x / ancho, y: p.y / ancho, pressure: p.pressure, time: (p.time - t0) / ancho })) };
  });
}

function desnormalizar(trazos: Trazos, ancho: number): PointGroup[] {
  const g = grosores(ancho);
  return trazos.map((grupo) => ({
    ...grupo,
    ...g,
    penColor: estado.color,
    points: grupo.points.map((p) => ({ x: p.x * ancho, y: p.y * ancho, pressure: p.pressure, time: p.time * ancho })),
  }));
}

function svgDeTrazos(trazos: Trazos): string {
  const ratio = Math.max(window.devicePixelRatio || 1, 1);
  lienzoRef.width = Math.round(ANCHO_REF * ratio);
  lienzoRef.height = Math.round((ANCHO_REF / PROPORCION_PAD) * ratio);
  padRef.fromData(desnormalizar(trazos, ANCHO_REF));
  return padRef.toDataURL('image/svg+xml');
}

function cargarEnPad() {
  pad.clear();
  const c = actual();
  if (c?.trazos.length && anchoPad) pad.fromData(desnormalizar(c.trazos, anchoPad));
  $('pad-guia').hidden = !pad.isEmpty();
}

function ajustarPad() {
  const ancho = lienzoPad.offsetWidth;
  const alto = lienzoPad.offsetHeight;
  if (!ancho || !alto || ancho === anchoPad) return;
  const ratio = Math.max(window.devicePixelRatio || 1, 1);
  lienzoPad.width = Math.round(ancho * ratio);
  lienzoPad.height = Math.round(alto * ratio);
  lienzoPad.getContext('2d')!.scale(ratio, ratio);
  const g = grosores(ancho);
  pad.minWidth = g.minWidth;
  pad.maxWidth = g.maxWidth;
  anchoPad = ancho;
  cargarEnPad();
}

function cambiarTrazos(c: Casillero, trazos: Trazos) {
  c.trazos = trazos;
  c.recorte = null;
  invalidarResultado();
  if (c === actual()) $('pad-guia').hidden = trazos.length > 0;
  void componer([c]);
  refrescar();
}

function avisoPad(msg: string) {
  const pista = $('pista-enter');
  pista.hidden = false;
  pista.textContent = msg;
  pista.classList.add('alerta');
  $('pf-titulo').textContent = msg;
  clearTimeout(Number(pista.dataset.t));
  pista.dataset.t = String(
    window.setTimeout(() => {
      pista.textContent = 'También podés apretar Enter.';
      pista.classList.remove('alerta');
      refrescar();
    }, 2500),
  );
}

function destello() {
  const marco = $('pad-marco');
  marco.classList.remove('cambio');
  void marco.offsetWidth;
  marco.classList.add('cambio');
}

function siguiente() {
  const c = actual();
  if (!c) return;
  if (!c.trazos.length) {
    avisoPad('✍️ Primero firmá en el recuadro.');
    return;
  }
  const n = estado.casilleros.length;
  if (estado.actual < n - 1) {
    seleccionar(estado.actual + 1);
    destello();
    return;
  }
  const faltan = estado.casilleros.findIndex((x) => !x.trazos.length);
  if (faltan >= 0) {
    seleccionar(faltan);
    destello();
    avisoPad(`Falta la firma ${faltan + 1}.`);
    return;
  }
  cerrarPantallaCompleta();
  $('paso-final').scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('firmar').focus({ preventScroll: true });
}

let ajustarGrande: (() => void) | null = null;

function cerrarPantallaCompleta() {
  if ($('pantalla-firma').hidden) return;
  if (ajustarGrande) window.removeEventListener('resize', ajustarGrande);
  const marco = $('pad-marco');
  marco.style.width = '';
  $('pad-lugar').append(marco);
  $('pantalla-firma').hidden = true;
  document.body.classList.remove('sin-scroll');
  $('zona-pad').scrollIntoView({ block: 'center' });
}

function prepararPad() {
  new ResizeObserver(() => ajustarPad()).observe(lienzoPad);
  pad.addEventListener('endStroke', () => {
    const c = actual();
    if (c && anchoPad) cambiarTrazos(c, normalizar(pad.toData(), anchoPad));
  });
  const deshacer = () => {
    const c = actual();
    if (!c) return;
    cambiarTrazos(c, c.trazos.slice(0, -1));
    cargarEnPad();
  };
  const borrar = () => {
    const c = actual();
    if (!c) return;
    cambiarTrazos(c, []);
    cargarEnPad();
  };
  $('deshacer').addEventListener('click', deshacer);
  $('pf-deshacer').addEventListener('click', deshacer);
  $('borrar').addEventListener('click', borrar);
  $('pf-borrar').addEventListener('click', borrar);
  $('siguiente').addEventListener('click', siguiente);
  $('pf-sig').addEventListener('click', siguiente);
  $('pf-ant').addEventListener('click', () => {
    seleccionar(estado.actual - 1);
    destello();
  });
  $('pf-cerrar').addEventListener('click', cerrarPantallaCompleta);
  document.querySelectorAll<HTMLButtonElement>('.tinta').forEach((b) =>
    b.addEventListener('click', () => {
      estado.color = b.dataset.color!;
      pad.penColor = estado.color;
      document.querySelectorAll<HTMLButtonElement>('.tinta').forEach((x) => {
        x.classList.toggle('activa', x === b);
        x.setAttribute('aria-checked', String(x === b));
      });
      cargarEnPad();
      invalidarResultado();
      void componer(estado.casilleros);
    }),
  );

  // Pantalla completa: el mismo recuadro pasa a una capa grande.
  const marco = $('pad-marco');
  ajustarGrande = () => {
    const ancho = Math.min(window.innerWidth - 24, (window.innerHeight - 150) * PROPORCION_PAD, 1100);
    marco.style.width = `${Math.floor(ancho)}px`;
  };
  $('ampliar').addEventListener('click', () => {
    $('pantalla-firma').hidden = false;
    $('pf-lugar').append(marco);
    document.body.classList.add('sin-scroll');
    ajustarGrande!();
    window.addEventListener('resize', ajustarGrande!);
  });

  // Enter = siguiente firma (fuera de los campos de texto).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || estado.preparar || !estado.original || estado.firmado) return;
    if ((e.target as HTMLElement).closest('textarea, input, select, button, a')) return;
    e.preventDefault();
    siguiente();
  });
}

/* ───────────── Imagen de cada firma con los datos ───────────── */

let cola: Promise<unknown> = Promise.resolve();

/** Arma (en orden) la imagen de cada firma: el trazo de esa firma + los datos de abajo. */
function componer(casilleros: Casillero[], fecha?: Date): Promise<void> {
  const tarea = cola.then(async () => {
    for (const c of casilleros) {
      if (!estado.casilleros.includes(c)) continue;
      const trazos = c.trazos;
      if (!trazos.length) {
        liberar(c);
        continue;
      }
      if (!c.recorte || c.recorteColor !== estado.color) {
        const color = estado.color;
        const recorte = await rasterizarFirma(svgDeTrazos(trazos));
        if (c.trazos !== trazos) continue;
        c.recorte = recorte;
        c.recorteColor = color;
      }
      const img = await componerImagen({
        firma: c.recorte,
        texto: texto(),
        fecha: conFecha() ? fechaDeFirma(fecha ?? new Date()) : null,
        color: estado.color,
      });
      if (c.trazos !== trazos || !estado.casilleros.includes(c)) {
        if (img) URL.revokeObjectURL(img.url);
        continue;
      }
      liberar(c);
      c.imagen = img;
    }
    actualizarUbicaciones();
    refrescar();
  });
  cola = tarea.catch(() => undefined);
  return tarea;
}

let temporizador = 0;
function componerTodasPronto() {
  clearTimeout(temporizador);
  temporizador = window.setTimeout(() => void componer(estado.casilleros), 300);
}

/* ───────────── Firmar y descargar ───────────── */

async function descartarFirmado() {
  if (!estado.firmado) return;
  estado.firmado = null;
  const v = estado.visorFirmado;
  estado.visorFirmado = null;
  await v?.cerrar();
}

function invalidarResultado() {
  if (!estado.firmado) return;
  void descartarFirmado();
  $('resultado').hidden = true;
  $('firmar').hidden = false;
  $('aviso-firmado').hidden = true;
  if (estado.visor) armarHojas(estado.visor, true);
}

async function asegurarMascaras() {
  const visor = estado.visor!;
  await Promise.all([...new Set(estado.casilleros.map((c) => c.hoja))].map((h) => visor.mascara(h)));
  actualizarUbicaciones();
}

async function firmar() {
  const falta = $('falta');
  falta.textContent = '';
  if (!estado.original || !estado.visor) return;
  const sinFirmar = estado.casilleros.map((c, i) => (c.trazos.length ? 0 : i + 1)).filter(Boolean);
  if (sinFirmar.length) {
    falta.textContent =
      estado.casilleros.length === 1
        ? 'Falta tu firma.'
        : sinFirmar.length === 1
          ? `Falta una firma: ${lista(sinFirmar)}.`
          : `Faltan ${sinFirmar.length} firmas: ${lista(sinFirmar)}.`;
    seleccionar(sinFirmar[0] - 1);
    $('zona-pad').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  if (!texto().trim() && !confirm('No escribiste tus datos debajo de la firma. ¿Firmar igual?')) {
    $('texto').focus();
    return;
  }
  const boton = $<HTMLButtonElement>('firmar');
  boton.disabled = true;
  boton.textContent = 'Firmando…';
  try {
    await asegurarMascaras();
    clearTimeout(temporizador);
    await componer(estado.casilleros, new Date());
    const firmas = estado.casilleros.map((c) => {
      if (!c.imagen || !c.ubic) throw new Error('No se pudo armar la imagen de la firma.');
      return { hoja: c.hoja, png: c.imagen.png, aspecto: c.imagen.aspecto, ubicacion: c.ubic };
    });
    const pdf = await estamparFirmas(estado.original, firmas);
    await descartarFirmado();
    estado.firmado = { pdf, imagenes: firmas.map((f) => ({ hoja: f.hoja, png: f.png })) };
    const visorFirmado = new Visor(
      await abrirPdf(pdf),
      Math.min(1600, Math.max($('hojas').clientWidth, 320) * Math.min(window.devicePixelRatio || 1, 2)),
    );
    estado.visorFirmado = visorFirmado;
    armarHojas(visorFirmado, false);
    $('aviso-firmado').hidden = false;
    $('resultado').hidden = false;
    boton.hidden = true;
    const archivo = new File([pdf as BlobPart], `${nombreBase()} - firmado.pdf`, { type: 'application/pdf' });
    $('compartir').hidden = !(navigator.canShare && navigator.canShare({ files: [archivo] }));
    $('resultado').scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.querySelector(`#hojas [data-hoja="${firmas[0].hoja}"]`)?.scrollIntoView({ block: 'nearest' });
  } catch (e) {
    mostrarError(e instanceof Error ? `No se pudo firmar: ${e.message}` : 'No se pudo firmar el documento.');
  } finally {
    boton.disabled = false;
    boton.textContent = 'Firmar el documento';
  }
}

function prepararResultado() {
  $('firmar').addEventListener('click', () => void firmar());
  $('descargar').addEventListener('click', () => {
    if (estado.firmado) descargar(estado.firmado.pdf, `${nombreBase()} - firmado.pdf`, 'application/pdf');
  });
  $('descargar-imagen').addEventListener('click', () => {
    const f = estado.firmado;
    if (!f) return;
    if (f.imagenes.length === 1) {
      descargar(f.imagenes[0].png, `Firma - ${nombreBase()}.png`, 'image/png');
      return;
    }
    const ancho = String(f.imagenes.length).length;
    const zip = crearZip(
      f.imagenes.map((x, i) => ({ nombre: `Firma ${String(i + 1).padStart(ancho, '0')} - hoja ${x.hoja}.png`, datos: x.png })),
    );
    descargar(zip, `Firmas - ${nombreBase()}.zip`, 'application/zip');
  });
  $('compartir').addEventListener('click', async () => {
    if (!estado.firmado) return;
    const archivo = new File([estado.firmado.pdf as BlobPart], `${nombreBase()} - firmado.pdf`, { type: 'application/pdf' });
    try {
      await navigator.share({ files: [archivo], title: archivo.name });
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) descargar(estado.firmado.pdf, archivo.name, 'application/pdf');
    }
  });
  $('editar').addEventListener('click', () => {
    invalidarResultado();
    $('paso-firmas').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

/* ───────────── Estudio: preparar y mandar ───────────── */

function prepararEnvio() {
  const estadoEnvio = (msg: string, tipo: 'ok' | 'error' | 'info' = 'info') => {
    const el = $('env-estado');
    el.textContent = msg;
    el.dataset.tipo = tipo;
  };
  $('env-generar').addEventListener('click', async () => {
    const gh = conexion();
    if (!gh) {
      estadoEnvio('Primero conectá GitHub en el Panel del estudio (botón arriba a la derecha).', 'error');
      return;
    }
    if (!estado.original || !estado.visor) return;
    const boton = $<HTMLButtonElement>('env-generar');
    boton.disabled = true;
    try {
      estadoEnvio('Ubicando las firmas…');
      await asegurarMascaras();
      const firmas: LugarDeFirma[] = estado.casilleros.map((c) => ({ hoja: c.hoja, ubic: c.ubic! }));
      const titulo = $<HTMLInputElement>('env-titulo').value.trim() || nombreBase();
      const cabecera: Cabecera = {
        titulo,
        archivo: estado.nombre,
        instrucciones: $<HTMLTextAreaElement>('env-indicaciones').value.trim(),
        alcance: estado.modo === 'todas' ? 'todas' : 'ultima',
        firmas,
        fijo: !$<HTMLInputElement>('env-libre').checked,
        creado: new Date().toISOString(),
      };
      estadoEnvio('Cifrando y subiendo…');
      const clave = generarClave();
      const id = generarId();
      const cifrado = await cifrarDocumento(estado.original, cabecera, clave);
      await gh.asegurarRama();
      const sha = await gh.subir(rutaDocumento(id), cifrado, `Documento para firmar ${id}`);
      const link = crearEnlace(location.origin + location.pathname, { id, clave, repo: gh.repo }, repoDesdeUbicacion(location));
      agregarLink({ id, titulo, archivo: estado.nombre, link, repo: gh.repo, sha, fecha: new Date().toISOString(), firmas: firmas.length });
      $<HTMLInputElement>('env-link').value = link;
      $<HTMLAnchorElement>('env-abrir').href = link;
      $<HTMLAnchorElement>('env-whatsapp').href = `https://wa.me/?text=${encodeURIComponent(
        `Hola, te mando el documento «${titulo}» para que lo firmes desde el celular: ${link}`,
      )}`;
      $('env-resultado').hidden = false;
      estadoEnvio(`✅ Link generado (${firmas.length === 1 ? '1 firma' : `${firmas.length} firmas`}). Copialo y mandáselo al cliente.`, 'ok');
    } catch (e) {
      estadoEnvio(e instanceof Error ? e.message : 'No se pudo subir.', 'error');
    } finally {
      boton.disabled = false;
    }
  });
  $('env-copiar').addEventListener('click', async () => {
    const link = $<HTMLInputElement>('env-link').value;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      $<HTMLInputElement>('env-link').select();
      document.execCommand('copy');
    }
    $('env-copiar').textContent = '¡Copiado!';
    setTimeout(() => ($('env-copiar').textContent = 'Copiar link'), 1500);
  });
  $('env-link').addEventListener('focus', () => $<HTMLInputElement>('env-link').select());
  $('env-otro').addEventListener('click', () => location.reload());
}

function modoPreparar() {
  document.title = 'Preparar documento · Firma de documentos';
  $('marca-sub').textContent = ' · Estudio';
  $('volver-panel').hidden = false;
  $('titulo').textContent = 'Preparar un documento para firmar';
  $('bajada').textContent =
    'Elegí el PDF, marcá dónde tiene que firmar el cliente (se ubica solo debajo del texto; podés moverlo) y generá el link.';
  $('elegir-texto').textContent = 'Elegí el PDF que va a firmar el cliente';
  $('elegir-nota').textContent = '🔒 El PDF se cifra en este navegador antes de subirse.';
  $('pie-privacidad').textContent = 'El documento se cifra antes de subirse: sólo se abre con el link.';
  $('paso-datos').hidden = true;
  $('zona-pad').hidden = true;
  $('paso-final').hidden = true;
  $('paso-enviar').hidden = false;
  $('num-firmas').textContent = '1';
  $('titulo-firmas').textContent = 'Dónde firma el cliente';
}

/* ───────────── Inicio ───────────── */

async function abrirArchivo(f: File | undefined) {
  if (!f) return;
  if (f.type && f.type !== 'application/pdf' && !/\.pdf$/i.test(f.name)) {
    mostrarError('El archivo tiene que ser un PDF.');
    return;
  }
  cargando('Abriendo el documento…');
  try {
    await cargarPdf(new Uint8Array(await f.arrayBuffer()), f.name);
  } catch (e) {
    mostrarError(e instanceof Error ? e.message : 'No se pudo abrir el archivo.');
  } finally {
    cargando(null);
  }
}

function prepararEleccion() {
  const input = $<HTMLInputElement>('archivo');
  input.addEventListener('change', () => {
    void abrirArchivo(input.files?.[0]);
    input.value = '';
  });
  const zona = $('soltar');
  document.addEventListener('dragover', (e) => {
    if (estado.desdeLink) return;
    e.preventDefault();
    zona.classList.add('encima');
  });
  document.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) zona.classList.remove('encima');
  });
  document.addEventListener('drop', (e) => {
    if (estado.desdeLink) return;
    e.preventDefault();
    zona.classList.remove('encima');
    void abrirArchivo(e.dataTransfer?.files[0]);
  });
  $('cambiar').addEventListener('click', () => input.click());
}

async function iniciar() {
  if (estado.preparar) modoPreparar();
  prepararPad();
  prepararEditor();
  prepararResultado();
  prepararEnvio();
  prepararEleccion();
  const alCambiarDatos = () => {
    invalidarResultado();
    componerTodasPronto();
    if (!estado.casilleros.some((c) => c.imagen)) {
      actualizarUbicaciones();
      refrescar();
    }
  };
  $('texto').addEventListener('input', alCambiarDatos);
  $('con-fecha').addEventListener('change', alCambiarDatos);
  window.addEventListener('hashchange', () => location.reload());
  const conLink = await abrirDesdeLink();
  if (!conLink) {
    $('elegir').hidden = false;
    $('pie-estudio').hidden = estado.preparar;
  }
}

void iniciar();
