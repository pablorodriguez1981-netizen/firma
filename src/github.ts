/**
 * Subida de documentos cifrados al repositorio, con un token de GitHub del
 * estudio (permiso "Contents: Read and write" sobre este repositorio).
 * Los documentos van a una rama aparte, sin historial de la app, para que
 * subir un caso no dispare compilaciones ni publicaciones.
 */
import { RAMA } from './enlace';

const API = 'https://api.github.com';

export class ErrorGitHub extends Error {
  constructor(
    message: string,
    readonly estado: number,
  ) {
    super(message);
    this.name = 'ErrorGitHub';
  }
}

function mensajeDeError(estado: number, detalle: string): string {
  if (estado === 401) return 'El token no es válido o venció. Generá uno nuevo.';
  if (estado === 403) return 'El token no tiene permiso para escribir en el repositorio (hace falta "Contents: Read and write").';
  if (estado === 404) return 'No se encontró el repositorio (o el token no tiene acceso a él).';
  if (estado === 413 || estado === 422) return `GitHub rechazó el archivo: ${detalle || 'revisá que no sea demasiado grande'}.`;
  return `Error de GitHub (${estado})${detalle ? `: ${detalle}` : ''}.`;
}

export async function aBase64(bytes: Uint8Array): Promise<string> {
  const url = await new Promise<string>((ok, mal) => {
    const lector = new FileReader();
    lector.onload = () => ok(String(lector.result));
    lector.onerror = () => mal(lector.error);
    lector.readAsDataURL(new Blob([bytes as BlobPart]));
  });
  return url.slice(url.indexOf(',') + 1);
}

const LEEME = `# Documentos para firmar

Esta rama guarda los documentos que el estudio sube desde el panel de firma.
Cada archivo está cifrado (AES-GCM de 256 bits): sin la clave, que sólo
figura en el link enviado al cliente, no se puede leer.
`;

export class GitHub {
  constructor(
    private readonly token: string,
    readonly repo: string,
  ) {}

  private async pedir<T>(metodo: string, ruta: string, cuerpo?: unknown): Promise<T> {
    let r: Response;
    try {
      r = await fetch(`${API}${ruta}`, {
        method: metodo,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(cuerpo ? { 'Content-Type': 'application/json' } : {}),
        },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
        cache: 'no-store',
      });
    } catch {
      throw new ErrorGitHub('No hay conexión con GitHub. Revisá internet y probá de nuevo.', 0);
    }
    if (!r.ok) {
      let detalle = '';
      try {
        detalle = ((await r.json()) as { message?: string }).message ?? '';
      } catch {
        /* sin cuerpo */
      }
      throw new ErrorGitHub(mensajeDeError(r.status, detalle), r.status);
    }
    return (r.status === 204 ? null : await r.json()) as T;
  }

  /** Verifica el token y el permiso de escritura. */
  async verificar(): Promise<{ privado: boolean; escritura: boolean }> {
    const datos = await this.pedir<{ private: boolean; permissions?: { push?: boolean } }>('GET', `/repos/${this.repo}`);
    return { privado: datos.private, escritura: !!datos.permissions?.push };
  }

  /** Crea la rama de documentos (sin historial) si todavía no existe. */
  async asegurarRama(): Promise<void> {
    try {
      await this.pedir('GET', `/repos/${this.repo}/git/ref/heads/${RAMA}`);
      return;
    } catch (e) {
      if (!(e instanceof ErrorGitHub) || e.estado !== 404) throw e;
    }
    const arbol = await this.pedir<{ sha: string }>('POST', `/repos/${this.repo}/git/trees`, {
      tree: [{ path: 'LEEME.md', mode: '100644', type: 'blob', content: LEEME }],
    });
    const commit = await this.pedir<{ sha: string }>('POST', `/repos/${this.repo}/git/commits`, {
      message: 'Rama para documentos a firmar',
      tree: arbol.sha,
      parents: [],
    });
    await this.pedir('POST', `/repos/${this.repo}/git/refs`, { ref: `refs/heads/${RAMA}`, sha: commit.sha });
  }

  /** Sube un archivo a la rama de documentos y devuelve su sha (para poder borrarlo). */
  async subir(ruta: string, bytes: Uint8Array, mensaje: string): Promise<string> {
    const r = await this.pedir<{ content: { sha: string } }>('PUT', `/repos/${this.repo}/contents/${ruta}`, {
      message: mensaje,
      content: await aBase64(bytes),
      branch: RAMA,
    });
    return r.content.sha;
  }

  async borrar(ruta: string, sha: string, mensaje: string): Promise<void> {
    try {
      await this.pedir('DELETE', `/repos/${this.repo}/contents/${ruta}`, { message: mensaje, sha, branch: RAMA });
    } catch (e) {
      // Si ya no estaba, no hay nada que borrar.
      if (!(e instanceof ErrorGitHub) || e.estado !== 404) throw e;
    }
  }
}
