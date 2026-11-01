/**
 * Datos del estudio guardados sólo en este navegador: token de GitHub,
 * repositorio y links generados (los comparten el panel y la preparación
 * de documentos).
 */
import { GitHub } from './github';

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
