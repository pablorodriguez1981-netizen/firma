/**
 * Links para firmar: dónde está el documento cifrado y con qué clave se abre.
 *
 * Ejemplo: https://usuario.github.io/firma/#d=1a2b3c4d5e6f7a8b&k=<clave>
 * Si el repositorio no se deduce de la dirección de la página, va en "r".
 */

export const RAMA = 'firmas-casos';
export const CARPETA = 'casos';

export interface DatosEnlace {
  id: string;
  clave: string;
  /** "usuario/repositorio" (si falta, se deduce de la dirección de la página). */
  repo?: string;
}

const REPO_VALIDO = /^[\w.-]+\/[\w.-]+$/;

/** Con GitHub Pages (usuario.github.io/repositorio/...), el repositorio que publica la página. */
export function repoDesdeUbicacion(ubic: { hostname: string; pathname: string }): string | null {
  const m = /^([\w-]+)\.github\.io$/i.exec(ubic.hostname);
  if (!m) return null;
  const usuario = m[1];
  const primero = ubic.pathname.split('/').filter(Boolean)[0];
  if (!primero) return `${usuario}/${usuario}.github.io`;
  return `${usuario}/${primero}`;
}

export function crearEnlace(pagina: string, datos: DatosEnlace, repoPredeterminado: string | null): string {
  const p = new URLSearchParams({ d: datos.id, k: datos.clave });
  if (datos.repo && datos.repo !== repoPredeterminado) p.set('r', datos.repo);
  return `${pagina.split('#')[0]}#${p.toString()}`;
}

export function leerEnlace(hash: string, repoPredeterminado: string | null): DatosEnlace | null {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const id = p.get('d');
  const clave = p.get('k');
  const repo = p.get('r') ?? repoPredeterminado ?? undefined;
  if (!id || !clave || !/^[a-f0-9]{8,64}$/.test(id) || !/^[\w-]{40,50}$/.test(clave)) return null;
  if (repo && !REPO_VALIDO.test(repo)) return null;
  return { id, clave, repo };
}

export function rutaDocumento(id: string): string {
  return `${CARPETA}/${id}.firma`;
}

export function urlDocumento(repo: string, id: string): string {
  return `https://raw.githubusercontent.com/${repo}/${RAMA}/${rutaDocumento(id)}`;
}

export function esRepoValido(repo: string): boolean {
  return REPO_VALIDO.test(repo);
}
