/**
 * Panel del estudio: conecta el repositorio de documentos, sube PDF para
 * firmar (cifrados) y muestra cuáles ya firmó el cliente para descargarlos.
 */
import './firma.css';
import { GitHub, ErrorGitHub } from './github';
import { LinkInvalidoError, descifrarDocumento, type Cabecera, type Devolucion } from './cifrado';
import { claveDeEnlace, esRepoValido, repoDatosPredeterminado, rutaDocumento, rutaFirmado } from './enlace';
import { PdfProtegidoError, leerInfoPdf } from './estampar';
import { CLAVE_REPO, CLAVE_TOKEN, conexion, guardar, guardarLinks, leer, links, publicarDocumento, type LinkGuardado } from './almacen';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const TAMANO_MAXIMO = 40 * 1024 * 1024;

const repoPredeterminado = repoDatosPredeterminado(location);
const paginaCliente = new URL('../', location.href).href;

function estado(id: string, msg: string, tipo: 'ok' | 'error' | 'info' = 'info') {
  const el = $(id);
  el.textContent = msg;
  el.dataset.tipo = tipo;
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

/* ───────────── Conexión ───────────── */

function mostrarConexion() {
  const gh = conexion();
  $('conexion-form').hidden = !!gh;
  $('conexion-ok').hidden = !gh;
  const chip = $('chip-conexion');
  chip.textContent = gh ? 'Conectado' : 'Sin conectar';
  chip.dataset.tipo = gh ? 'ok' : '';
  if (gh) $('conexion-detalle').textContent = `Documentos en: ${gh.repo}`;
  const repo = leer(CLAVE_REPO) ?? repoPredeterminado ?? '';
  $<HTMLInputElement>('repo').value = repo;
  const nombre = repo.split('/')[1] || 'firma-datos';
  $('repo-sugerido').textContent = nombre;
  $('repo-nombre').textContent = nombre;
}

async function conectar() {
  const repo = $<HTMLInputElement>('repo').value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '');
  const token = $<HTMLInputElement>('token').value.trim();
  if (!esRepoValido(repo)) return estado('estado-conexion', 'Escribí el repositorio como usuario/firma-datos.', 'error');
  if (!token) return estado('estado-conexion', 'Pegá el token de GitHub.', 'error');
  const boton = $<HTMLButtonElement>('conectar');
  boton.disabled = true;
  estado('estado-conexion', 'Probando…');
  try {
    const gh = new GitHub(token, repo);
    const { privado, escritura } = await gh.verificar();
    if (!escritura) throw new ErrorGitHub('El token no tiene permiso de escritura (Contents: Read and write) en ese repositorio.', 403);
    guardar(CLAVE_TOKEN, token);
    guardar(CLAVE_REPO, repo);
    $<HTMLInputElement>('token').value = '';
    mostrarConexion();
    estado(
      'estado-conexion',
      privado
        ? '✅ Conectado. Ya podés mandar documentos.'
        : '✅ Conectado. Recomendado: hacé privado el repositorio de documentos (Settings › Danger Zone › Change visibility). Igual todo va cifrado.',
      'ok',
    );
    void actualizarEstados();
  } catch (e) {
    estado('estado-conexion', e instanceof Error ? e.message : 'No se pudo conectar.', 'error');
  } finally {
    boton.disabled = false;
  }
}

/* ───────────── Subida rápida ───────────── */

let elegidos: File[] = [];

function mostrarElegidos() {
  $('elegidos').replaceChildren(
    ...elegidos.map((f) => {
      const li = document.createElement('li');
      li.textContent = `📄 ${f.name} · ${(f.size / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
      return li;
    }),
  );
}

function elegir(lista: FileList | null | undefined) {
  if (!lista) return;
  elegidos = Array.from(lista).filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (lista.length && !elegidos.length) estado('estado-subida', 'Elegí archivos PDF.', 'error');
  else estado('estado-subida', '');
  mostrarElegidos();
}

async function subir() {
  if (!conexion()) return estado('estado-subida', 'Primero conectá GitHub (paso 1).', 'error');
  if (!elegidos.length) return estado('estado-subida', 'Elegí al menos un PDF.', 'error');
  const boton = $<HTMLButtonElement>('subir');
  boton.disabled = true;
  const tituloComun = $<HTMLInputElement>('titulo').value.trim();
  const instrucciones = $<HTMLTextAreaElement>('indicaciones').value.trim();
  const alcance = (document.querySelector<HTMLInputElement>('input[name=sugerencia]:checked')?.value ?? 'ultima') as Cabecera['alcance'];
  const avisos: string[] = [];
  let hechos = 0;
  try {
    for (const [i, f] of elegidos.entries()) {
      const prefijo = elegidos.length > 1 ? `(${i + 1}/${elegidos.length}) ` : '';
      if (f.size > TAMANO_MAXIMO) {
        avisos.push(`«${f.name}» pesa más de 40 MB: no se subió.`);
        continue;
      }
      estado('estado-subida', `${prefijo}Revisando «${f.name}»…`);
      const pdf = new Uint8Array(await f.arrayBuffer());
      try {
        const info = await leerInfoPdf(pdf);
        if (info.firmasDigitales) avisos.push(`«${f.name}» tiene firmas digitales: al firmarlo el cliente, dejan de verificarse.`);
      } catch (e) {
        avisos.push(
          e instanceof PdfProtegidoError
            ? `«${f.name}» está protegido con contraseña o contra cambios: no se puede firmar. Guardalo de nuevo sin protección.`
            : `«${f.name}» no parece un PDF válido: no se subió.`,
        );
        continue;
      }
      estado('estado-subida', `${prefijo}Cifrando y subiendo «${f.name}»…`);
      const titulo = elegidos.length > 1 || !tituloComun ? f.name.replace(/\.pdf$/i, '') : tituloComun;
      await publicarDocumento(pdf, { titulo, archivo: f.name, instrucciones, alcance, creado: new Date().toISOString() }, paginaCliente);
      hechos++;
      mostrarLista();
    }
    const resumen = hechos ? `✅ ${hechos === 1 ? 'Link generado' : `${hechos} links generados`}: copialo en «Documentos» y mandáselo al cliente.` : '';
    estado('estado-subida', [resumen, ...avisos].filter(Boolean).join('\n'), avisos.length && !hechos ? 'error' : 'ok');
    if (hechos) {
      elegidos = [];
      mostrarElegidos();
      $<HTMLInputElement>('titulo').value = '';
      $('lista').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } catch (e) {
    estado('estado-subida', [e instanceof Error ? e.message : 'No se pudo subir.', ...avisos].join('\n'), 'error');
  } finally {
    boton.disabled = false;
  }
}

/* ───────────── Documentos: pendientes y firmados ───────────── */

/** ids de los documentos ya firmados por el cliente (null: todavía no se consultó). */
let firmados: Set<string> | null = null;

async function actualizarEstados() {
  const gh = conexion();
  if (!gh || !links().length) {
    firmados = null;
    mostrarLista();
    return;
  }
  const boton = $<HTMLButtonElement>('actualizar');
  boton.disabled = true;
  estado('estado-lista', 'Buscando documentos firmados…');
  try {
    const archivos = await gh.listar('firmados');
    firmados = new Set(archivos.map((a) => a.nombre.replace(/\.firma$/, '')));
    estado('estado-lista', '');
  } catch (e) {
    estado('estado-lista', e instanceof Error ? e.message : 'No se pudo consultar GitHub.', 'error');
  } finally {
    boton.disabled = false;
    mostrarLista();
  }
}

async function copiar(texto: string, b: HTMLButtonElement) {
  try {
    await navigator.clipboard.writeText(texto);
  } catch {
    const t = document.createElement('textarea');
    t.value = texto;
    document.body.append(t);
    t.select();
    document.execCommand('copy');
    t.remove();
  }
  const antes = b.textContent;
  b.textContent = '¡Copiado!';
  setTimeout(() => (b.textContent = antes), 1500);
}

function boton(texto: string, clase = 'boton chico') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = clase;
  b.textContent = texto;
  return b;
}

async function descargarFirmado(l: LinkGuardado, b: HTMLButtonElement) {
  const gh = conexion();
  const clave = claveDeEnlace(l.link);
  if (!gh || !clave) return;
  const antes = b.textContent;
  b.disabled = true;
  b.textContent = 'Descargando…';
  try {
    const { cabecera, pdf } = await descifrarDocumento<Devolucion>(await gh.leer(rutaFirmado(l.id)), clave);
    descargar(pdf, `${(cabecera.archivo || l.archivo).replace(/\.pdf$/i, '')} - firmado.pdf`, 'application/pdf');
    const firmante = cabecera.datos?.trim();
    if (firmante) {
      guardarLinks(links().map((x) => (x.id === l.id ? { ...x, firmante } : x)));
      mostrarLista();
    }
  } catch (e) {
    alert(e instanceof LinkInvalidoError ? 'No se pudo abrir el documento firmado.' : e instanceof Error ? e.message : 'No se pudo descargar.');
  } finally {
    b.disabled = false;
    b.textContent = antes;
  }
}

async function borrar(l: LinkGuardado) {
  if (!confirm(`¿Borrar «${l.titulo}»? Se borran el documento y, si está, el firmado. El link deja de funcionar.`)) return;
  const token = leer(CLAVE_TOKEN);
  try {
    if (token) {
      const gh = new GitHub(token, l.repo);
      await gh.borrar(rutaDocumento(l.id), `Borrar documento ${l.id}`);
      await gh.borrar(rutaFirmado(l.id), `Borrar documento firmado ${l.id}`);
    } else if (!confirm('No hay token guardado: sólo se va a quitar de esta lista (los archivos cifrados quedan en GitHub). ¿Seguir?')) {
      return;
    }
    guardarLinks(links().filter((x) => x.id !== l.id));
    mostrarLista();
  } catch (e) {
    alert(e instanceof Error ? e.message : 'No se pudo borrar.');
  }
}

function mostrarLista() {
  const lista = links();
  $('lista-vacia').hidden = lista.length > 0;
  $('lista').replaceChildren(
    ...lista.map((l) => {
      const firmado = firmados?.has(l.id) ?? false;
      const li = document.createElement('li');
      li.className = `link-item${firmado ? ' firmado' : ''}`;
      const cab = document.createElement('div');
      cab.className = 'link-cab';
      const fila = document.createElement('div');
      fila.className = 'link-titulo';
      const t = document.createElement('strong');
      t.textContent = l.titulo;
      const chip = document.createElement('span');
      chip.className = 'estado-chip';
      chip.dataset.tipo = firmado ? 'ok' : '';
      chip.textContent = firmados === null ? '…' : firmado ? '✅ Firmado' : '⏳ Esperando firma';
      fila.append(t, chip);
      const f = document.createElement('small');
      const firmas = l.firmas ? ` · ${l.firmas === 1 ? '1 firma' : `${l.firmas} firmas`}` : '';
      f.textContent = `${l.archivo} · enviado el ${new Date(l.fecha).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })}${firmas}`;
      cab.append(fila, f);
      if (l.firmante) {
        const quien = document.createElement('small');
        quien.className = 'link-firmante';
        quien.textContent = `Firmó: ${l.firmante.split('\n').filter(Boolean).slice(0, 2).join(' · ')}`;
        cab.append(quien);
      }
      const acciones = document.createElement('div');
      acciones.className = 'fila-botones';
      if (firmado) {
        const bBajar = boton('⬇ Descargar firmado', 'boton chico principal');
        bBajar.addEventListener('click', () => void descargarFirmado(l, bBajar));
        acciones.append(bBajar);
      }
      const bCopiar = boton('Copiar link', firmado ? 'boton chico' : 'boton chico principal');
      bCopiar.addEventListener('click', () => void copiar(l.link, bCopiar));
      const wa = document.createElement('a');
      wa.className = 'boton chico';
      wa.target = '_blank';
      wa.rel = 'noopener';
      wa.textContent = 'WhatsApp';
      wa.href = `https://wa.me/?text=${encodeURIComponent(`Hola, te mando el documento «${l.titulo}» para que lo firmes desde el celular: ${l.link}`)}`;
      const bBorrar = boton('Borrar', 'boton chico peligro');
      bBorrar.addEventListener('click', () => void borrar(l));
      acciones.append(bCopiar, wa, bBorrar);
      li.append(cab, acciones);
      return li;
    }),
  );
}

/* ───────────── Inicio ───────────── */

function iniciar() {
  mostrarConexion();
  mostrarLista();
  void actualizarEstados();
  const repo = $<HTMLInputElement>('repo').value;
  if (repo.includes('/')) {
    // GitHub completa el formulario del token con estos datos (si no, se completan a mano).
    const u = new URL('https://github.com/settings/personal-access-tokens/new');
    u.searchParams.set('name', 'Firma de documentos');
    u.searchParams.set('description', `Documentos para firmar (${repo})`);
    u.searchParams.set('target_name', repo.split('/')[0]);
    u.searchParams.set('contents', 'write');
    $<HTMLAnchorElement>('link-token').href = u.href;
  }
  $('conectar').addEventListener('click', () => void conectar());
  $('token').addEventListener('keydown', (e) => e.key === 'Enter' && void conectar());
  $('olvidar').addEventListener('click', () => {
    if (!confirm('¿Desconectar? Se borra el token de este navegador (los links ya enviados siguen funcionando).')) return;
    guardar(CLAVE_TOKEN, null);
    mostrarConexion();
    estado('estado-conexion', 'Token borrado de este navegador.');
  });
  $('actualizar').addEventListener('click', () => void actualizarEstados());
  // Al volver a la pestaña, se revisa si llegaron firmados nuevos.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void actualizarEstados();
  });
  const input = $<HTMLInputElement>('archivos');
  input.addEventListener('change', () => elegir(input.files));
  const zona = $('soltar');
  zona.addEventListener('dragover', (e) => {
    e.preventDefault();
    zona.classList.add('encima');
  });
  zona.addEventListener('dragleave', () => zona.classList.remove('encima'));
  zona.addEventListener('drop', (e) => {
    e.preventDefault();
    zona.classList.remove('encima');
    elegir(e.dataTransfer?.files);
  });
  $('subir').addEventListener('click', () => void subir());
}

iniciar();
