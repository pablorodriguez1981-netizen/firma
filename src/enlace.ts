/**
 * Links para firmar: qué documento abrir, con qué clave y con qué permiso
 * (cifrado) el cliente guarda el documento firmado para el estudio.
 *
 * Ejemplo: https://usuario.github.io/firma/#d=1a2b3c4d5e6f7a8b&k=<clave>&t=<permiso cifrado>
 * Si el repositorio de documentos no es el predeterminado (usuario/firma-datos), va en "r".
 */

/** Nombre predeterminado del repositorio (privado) donde se guardan los documentos. */
export const REPO_DATOS = 'firma-datos';

export interface DatosEnlace {
  id: string;
  clave: string;
  /** Token de GitHub cifrado con la clave del documento. */
  token: string;
  /** "usuario/repositorio" de los documentos. */
  repo?: string;
}

const REPO_VALIDO = /^[\w.-]+\/[\w.-]+$/;

/** Con GitHub Pages (usuario.github.io/...), el repositorio de documentos predeterminado: usuario/firma-datos. */
export function repoDatosPredeterminado(ubic: { hostname: string }): string | null {
  const m = /^([\w-]+)\.github\.io$/i.exec(ubic.hostname);
  return m ? `${m[1]}/${REPO_DATOS}` : null;
}

export function crearEnlace(pagina: string, datos: DatosEnlace, repoPredeterminado: string | null): string {
  const p = new URLSearchParams({ d: datos.id, k: datos.clave, t: datos.token });
  if (datos.repo && datos.repo !== repoPredeterminado) p.set('r', datos.repo);
  return `${pagina.split('#')[0]}#${p.toString()}`;
}

export function leerEnlace(hash: string, repoPredeterminado: string | null): DatosEnlace | null {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const id = p.get('d');
  const clave = p.get('k');
  const token = p.get('t');
  const repo = p.get('r') ?? repoPredeterminado ?? undefined;
  if (!id || !clave || !token || !/^[a-f0-9]{8,64}$/.test(id) || !/^[\w-]{40,50}$/.test(clave) || !/^[\w-]{20,400}$/.test(token)) {
    return null;
  }
  if (repo && !REPO_VALIDO.test(repo)) return null;
  return { id, clave, token, repo };
}

/** Documento a firmar (cifrado). */
export function rutaDocumento(id: string): string {
  return `casos/${id}.firma`;
}

/** Documento firmado que devuelve el cliente (cifrado con la misma clave). */
export function rutaFirmado(id: string): string {
  return `firmados/${id}.firma`;
}

export function esRepoValido(repo: string): boolean {
  return REPO_VALIDO.test(repo);
}

/** Clave del documento a partir de un link guardado. */
export function claveDeEnlace(link: string): string | null {
  try {
    return new URLSearchParams(new URL(link).hash.slice(1)).get('k');
  } catch {
    return null;
  }
}
