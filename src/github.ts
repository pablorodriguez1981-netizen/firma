/**
 * Acceso al repositorio (privado) de documentos con un token de GitHub
 * (permiso "Contents: Read and write" sólo sobre ese repositorio).
 * Todo lo que se guarda va cifrado.
 */

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
  if (estado === 401) return 'La autorización de GitHub no es válida o venció.';
  if (estado === 403) return 'El token no tiene permiso de escritura en el repositorio de documentos (Contents: Read and write).';
  if (estado === 404) return 'No se encontró el repositorio de documentos o el token no tiene acceso.';
  if (estado === 409) return 'GitHub estaba procesando otra operación. Intente nuevamente.';
  if (estado === 413 || estado === 422) return `GitHub rechazó el archivo: ${detalle || 'puede ser demasiado grande'}.`;
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

export interface ArchivoRemoto {
  nombre: string;
  sha: string;
  tamano: number;
}

export class GitHub {
  constructor(
    private readonly token: string,
    readonly repo: string,
  ) {}

  private async respuesta(metodo: string, ruta: string, cuerpo?: unknown, crudo = false): Promise<Response> {
    let r: Response;
    try {
      r = await fetch(`${API}${ruta}`, {
        method: metodo,
        headers: {
          Accept: crudo ? 'application/vnd.github.raw' : 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(cuerpo ? { 'Content-Type': 'application/json' } : {}),
        },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
        cache: 'no-store',
      });
    } catch {
      throw new ErrorGitHub('No hay conexión con GitHub. Verifique la conexión a internet e intente nuevamente.', 0);
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
    return r;
  }

  private async pedir<T>(metodo: string, ruta: string, cuerpo?: unknown): Promise<T> {
    const r = await this.respuesta(metodo, ruta, cuerpo);
    return (r.status === 204 ? null : await r.json()) as T;
  }

  private contenidos(ruta: string) {
    return `/repos/${this.repo}/contents/${ruta.split('/').map(encodeURIComponent).join('/')}`;
  }

  /** Verifica el token y el permiso de escritura. */
  async verificar(): Promise<{ privado: boolean; escritura: boolean }> {
    const datos = await this.pedir<{ private: boolean; permissions?: { push?: boolean } }>('GET', `/repos/${this.repo}`);
    return { privado: datos.private, escritura: !!datos.permissions?.push };
  }

  /** Contenido de un archivo. */
  async leer(ruta: string): Promise<Uint8Array> {
    const r = await this.respuesta('GET', this.contenidos(ruta), undefined, true);
    return new Uint8Array(await r.arrayBuffer());
  }

  /** sha de un archivo, o null si no existe. */
  async sha(ruta: string): Promise<string | null> {
    try {
      return (await this.pedir<{ sha: string }>('GET', this.contenidos(ruta))).sha;
    } catch (e) {
      if (e instanceof ErrorGitHub && e.estado === 404) return null;
      throw e;
    }
  }

  /** Archivos de una carpeta ([] si no existe). */
  async listar(carpeta: string): Promise<ArchivoRemoto[]> {
    try {
      const l = await this.pedir<{ name: string; sha: string; size: number; type: string }[]>('GET', this.contenidos(carpeta));
      return Array.isArray(l) ? l.filter((x) => x.type === 'file').map((x) => ({ nombre: x.name, sha: x.sha, tamano: x.size })) : [];
    } catch (e) {
      if (e instanceof ErrorGitHub && e.estado === 404) return [];
      throw e;
    }
  }

  /** Guarda un archivo (si ya existe, lo reemplaza) y devuelve su sha. */
  async guardar(ruta: string, bytes: Uint8Array, mensaje: string): Promise<string> {
    const contenido = await aBase64(bytes);
    for (let intento = 0; ; intento++) {
      const sha = await this.sha(ruta);
      try {
        const r = await this.pedir<{ content: { sha: string } }>('PUT', this.contenidos(ruta), {
          message: mensaje,
          content: contenido,
          ...(sha ? { sha } : {}),
        });
        return r.content.sha;
      } catch (e) {
        // Dos guardados a la vez: se reintenta con el sha nuevo.
        if (intento < 2 && e instanceof ErrorGitHub && (e.estado === 409 || e.estado === 422)) continue;
        throw e;
      }
    }
  }

  async borrar(ruta: string, mensaje: string): Promise<void> {
    const sha = await this.sha(ruta);
    if (!sha) return;
    try {
      await this.pedir('DELETE', this.contenidos(ruta), { message: mensaje, sha });
    } catch (e) {
      if (!(e instanceof ErrorGitHub) || e.estado !== 404) throw e;
    }
  }
}
