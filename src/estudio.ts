/**
 * Panel del estudio: sube PDF cifrados al repositorio y genera los links
 * para que el cliente firme.
 */
import './firma.css';
import { GitHub, ErrorGitHub } from './github';
import { cifrarDocumento, generarClave, generarId, type Cabecera } from './cifrado';
import { crearEnlace, esRepoValido, repoDesdeUbicacion, rutaDocumento } from './enlace';
import { PdfProtegidoError, leerInfoPdf } from './estampar';
import { CLAVE_REPO, CLAVE_TOKEN, agregarLink, conexion, guardar, guardarLinks, leer, links, type LinkGuardado } from './almacen';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const TAMANO_MAXIMO = 40 * 1024 * 1024;

const repoPagina = repoDesdeUbicacion(location);
const paginaCliente = new URL('../', location.href).href;

function estado(id: string, msg: string, tipo: 'ok' | 'error' | 'info' = 'info') {
  const el = $(id);
  el.textContent = msg;
  el.dataset.tipo = tipo;
}

/* ───────────── Conexión ───────────── */

function mostrarConexion() {
  const gh = conexion();
  $('conexion-form').hidden = !!gh;
  $('conexion-ok').hidden = !gh;
  const chip = $('chip-conexion');
  chip.textContent = gh ? 'Conectado' : 'Sin conectar';
  chip.dataset.tipo = gh ? 'ok' : '';
  if (gh) $('conexion-detalle').textContent = `Repositorio: ${gh.repo}`;
  const repo = leer(CLAVE_REPO) ?? repoPagina ?? '';
  $<HTMLInputElement>('repo').value = repo;
  $('repo-sugerido').textContent = repo || 'tu repositorio';
}

async function conectar() {
  const repo = $<HTMLInputElement>('repo').value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '');
  const token = $<HTMLInputElement>('token').value.trim();
  if (!esRepoValido(repo)) return estado('estado-conexion', 'Escribí el repositorio como usuario/repositorio.', 'error');
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
        ? '⚠️ Conectado, pero el repositorio es privado: los clientes no van a poder abrir los links. Hacelo público (los documentos igual van cifrados).'
        : '✅ Conectado. Ya podés subir documentos.',
      privado ? 'error' : 'ok',
    );
  } catch (e) {
    estado('estado-conexion', e instanceof Error ? e.message : 'No se pudo conectar.', 'error');
  } finally {
    boton.disabled = false;
  }
}

/* ───────────── Subida ───────────── */

let elegidos: File[] = [];

function mostrarElegidos() {
  const ul = $('elegidos');
  ul.replaceChildren(
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
  const gh = conexion();
  if (!gh) return estado('estado-subida', 'Primero conectá GitHub (paso 1).', 'error');
  if (!elegidos.length) return estado('estado-subida', 'Elegí al menos un PDF.', 'error');
  const boton = $<HTMLButtonElement>('subir');
  boton.disabled = true;
  const tituloComun = $<HTMLInputElement>('titulo').value.trim();
  const instrucciones = $<HTMLTextAreaElement>('indicaciones').value.trim();
  const alcance = (document.querySelector<HTMLInputElement>('input[name=sugerencia]:checked')?.value ?? 'ultima') as Cabecera['alcance'];
  const avisos: string[] = [];
  let hechos = 0;
  try {
    estado('estado-subida', 'Preparando…');
    await gh.asegurarRama();
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
      const cabecera: Cabecera = { titulo, archivo: f.name, instrucciones, alcance, creado: new Date().toISOString() };
      const clave = generarClave();
      const id = generarId();
      const cifrado = await cifrarDocumento(pdf, cabecera, clave);
      const sha = await gh.subir(rutaDocumento(id), cifrado, `Documento para firmar ${id}`);
      const link = crearEnlace(paginaCliente, { id, clave, repo: gh.repo }, repoPagina);
      agregarLink({ id, titulo, archivo: f.name, link, repo: gh.repo, sha, fecha: new Date().toISOString() });
      hechos++;
      mostrarLista();
    }
    const resumen = hechos ? `✅ ${hechos === 1 ? 'Link generado' : `${hechos} links generados`}: copialo abajo y mandáselo al cliente.` : '';
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

/* ───────────── Lista de links ───────────── */

async function copiar(texto: string, boton: HTMLButtonElement) {
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
  const antes = boton.textContent;
  boton.textContent = '¡Copiado!';
  setTimeout(() => (boton.textContent = antes), 1500);
}

function boton(texto: string, clase = 'boton chico') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = clase;
  b.textContent = texto;
  return b;
}

async function borrar(l: LinkGuardado) {
  if (!confirm(`¿Borrar «${l.titulo}»? El link deja de funcionar.`)) return;
  const token = leer(CLAVE_TOKEN);
  try {
    if (token) await new GitHub(token, l.repo).borrar(rutaDocumento(l.id), l.sha, `Borrar documento ${l.id}`);
    else if (!confirm('No hay token guardado: sólo se va a quitar de esta lista (el archivo cifrado queda en GitHub). ¿Seguir?')) return;
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
      const li = document.createElement('li');
      li.className = 'link-item';
      const cab = document.createElement('div');
      cab.className = 'link-cab';
      const t = document.createElement('strong');
      t.textContent = l.titulo;
      const f = document.createElement('small');
      const firmas = l.firmas ? ` · ${l.firmas === 1 ? '1 firma marcada' : `${l.firmas} firmas marcadas`}` : '';
      f.textContent = `${l.archivo} · ${new Date(l.fecha).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })}${firmas}`;
      cab.append(t, f);
      const campo = document.createElement('input');
      campo.readOnly = true;
      campo.value = l.link;
      campo.className = 'link-campo';
      campo.addEventListener('focus', () => campo.select());
      const acciones = document.createElement('div');
      acciones.className = 'fila-botones';
      const bCopiar = boton('Copiar link', 'boton chico principal');
      bCopiar.addEventListener('click', () => void copiar(l.link, bCopiar));
      const wa = document.createElement('a');
      wa.className = 'boton chico';
      wa.target = '_blank';
      wa.rel = 'noopener';
      wa.textContent = 'WhatsApp';
      wa.href = `https://wa.me/?text=${encodeURIComponent(`Hola, te mando el documento «${l.titulo}» para que lo firmes desde el celular: ${l.link}`)}`;
      const abrir = document.createElement('a');
      abrir.className = 'boton chico';
      abrir.target = '_blank';
      abrir.rel = 'noopener';
      abrir.textContent = 'Abrir';
      abrir.href = l.link;
      const bBorrar = boton('Borrar', 'boton chico peligro');
      bBorrar.addEventListener('click', () => void borrar(l));
      acciones.append(bCopiar, wa, abrir, bBorrar);
      li.append(cab, campo, acciones);
      return li;
    }),
  );
}

/* ───────────── Inicio ───────────── */

function iniciar() {
  mostrarConexion();
  mostrarLista();
  const repo = $<HTMLInputElement>('repo').value;
  const nombreRepo = repo.split('/')[1];
  if (nombreRepo) {
    // GitHub completa el formulario del token con estos datos (si no, se completan a mano).
    const u = new URL('https://github.com/settings/personal-access-tokens/new');
    u.searchParams.set('name', 'Firma de documentos');
    u.searchParams.set('description', `Subir PDF cifrados para firmar (${repo})`);
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
