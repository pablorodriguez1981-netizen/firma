/**
 * Datos del estudio guardados sólo en este navegador: token de GitHub,
 * repositorio y links generados (los comparten el panel y la preparación
 * de documentos).
 */
import { GitHub } from './github';
import { cifrarDocumento, cifrarTexto, generarClave, generarId, type Cabecera } from './cifrado';
import { crearEnlace, repoDatosPredeterminado, rutaDocumento } from './enlace';

export const CLAVE_TOKEN = 'firma-estudio:token';
export const CLAVE_REPO = 'firma-estudio:repo';
const CLAVE_LINKS = 'firma-estudio:links';

export interface LinkGuardado {
  id: string;
  titulo: string;
  archivo: string;
  link: string;
  repo: string;
  sha: string;
  fecha: string;
  /** Cantidad de firmas marcadas por el estudio (si se preparó el documento). */
  firmas?: number;
  /** Datos que escribió el cliente (se completa al descargar el firmado). */
  firmante?: string;
}

export function leer(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

export function guardar(k: string, v: string | null) {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* almacenamiento no disponible */
  }
}

export function links(): LinkGuardado[] {
  try {
    const l = JSON.parse(leer(CLAVE_LINKS) ?? '[]') as unknown;
    return Array.isArray(l) ? (l as LinkGuardado[]) : [];
  } catch {
    return [];
  }
}

export function guardarLinks(l: LinkGuardado[]) {
  guardar(CLAVE_LINKS, JSON.stringify(l));
}

export function agregarLink(l: LinkGuardado) {
  guardarLinks([l, ...links().filter((x) => x.id !== l.id)]);
}

/** Cliente de GitHub con el token guardado, o null si el estudio no se conectó. */
export function conexion(): GitHub | null {
  const token = leer(CLAVE_TOKEN);
  const repo = leer(CLAVE_REPO);
  return token && repo ? new GitHub(token, repo) : null;
}

/**
 * Cifra y sube un documento para firmar y devuelve el link para el cliente.
 * El link lleva, cifrado con la clave del documento, el permiso para que el
 * cliente guarde el documento firmado en el repositorio de documentos.
 */
export async function publicarDocumento(pdf: Uint8Array, cabecera: Cabecera, paginaCliente: string): Promise<LinkGuardado> {
  const token = leer(CLAVE_TOKEN);
  const repo = leer(CLAVE_REPO);
  if (!token || !repo) throw new Error('Primero configure la conexión en el panel del estudio.');
  const gh = new GitHub(token, repo);
  const clave = generarClave();
  const id = generarId();
  const sha = await gh.guardar(rutaDocumento(id), await cifrarDocumento(pdf, cabecera, clave), `Documento para firmar ${id}`);
  const link = crearEnlace(paginaCliente, { id, clave, token: await cifrarTexto(token, clave), repo }, repoDatosPredeterminado(location));
  const guardado: LinkGuardado = {
    id,
    titulo: cabecera.titulo,
    archivo: cabecera.archivo,
    link,
    repo,
    sha,
    fecha: new Date().toISOString(),
    firmas: cabecera.firmas?.length,
  };
  agregarLink(guardado);
  return guardado;
}
