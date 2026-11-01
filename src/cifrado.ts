/**
 * Cifrado de los documentos que el estudio sube para firmar.
 *
 * El PDF se cifra en el navegador del estudio con AES-GCM (256 bits). En el
 * repositorio sólo queda el archivo cifrado; la clave viaja únicamente en el
 * link que recibe el cliente, después del "#", parte que los navegadores
 * nunca envían a ningún servidor.
 *
 * Formato: "FIRMA1" | iv (12 bytes) | AES-GCM( largo de cabecera (4 bytes) | cabecera JSON | PDF )
 */

import type { Ubicacion } from './ubicacion';

const MAGIA = new TextEncoder().encode('FIRMA1');

export interface LugarDeFirma {
  /** Hoja (base 1). */
  hoja: number;
  ubic: Ubicacion;
}

export interface Cabecera {
  titulo: string;
  archivo: string;
  instrucciones?: string;
  /** Sugerencia del estudio: una firma en la última hoja o una en cada hoja. */
  alcance?: 'ultima' | 'todas';
  /** Lugares de firma marcados por el estudio (uno por cada firma que hace el cliente). */
  firmas?: LugarDeFirma[];
  /** Si es true, el cliente no puede cambiar cuántas firmas ni en qué hojas (sí moverlas un poco). */
  fijo?: boolean;
  creado: string;
}

export function aBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function desdeBase64Url(texto: string): Uint8Array {
  const b64 = texto.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class LinkInvalidoError extends Error {
  constructor() {
    super('El link está incompleto o el documento está dañado.');
    this.name = 'LinkInvalidoError';
  }
}

function importarClave(texto: string, uso: KeyUsage) {
  const crudo = desdeBase64Url(texto);
  if (crudo.length !== 32) throw new LinkInvalidoError();
  return crypto.subtle.importKey('raw', crudo as BufferSource, 'AES-GCM', false, [uso]);
}

export function generarClave(): string {
  return aBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export function generarId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function cifrarDocumento(pdf: Uint8Array, cabecera: Cabecera, clave: string): Promise<Uint8Array> {
  const key = await importarClave(clave, 'encrypt');
  const cab = new TextEncoder().encode(JSON.stringify(cabecera));
  const plano = new Uint8Array(4 + cab.length + pdf.length);
  new DataView(plano.buffer).setUint32(0, cab.length);
  plano.set(cab, 4);
  plano.set(pdf, 4 + cab.length);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cifrado = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: MAGIA }, key, plano as BufferSource),
  );
  const out = new Uint8Array(MAGIA.length + iv.length + cifrado.length);
  out.set(MAGIA, 0);
  out.set(iv, MAGIA.length);
  out.set(cifrado, MAGIA.length + iv.length);
  return out;
}

export async function descifrarDocumento(datos: Uint8Array, clave: string): Promise<{ cabecera: Cabecera; pdf: Uint8Array }> {
  if (datos.length < MAGIA.length + 12 + 16 || MAGIA.some((b, i) => datos[i] !== b)) throw new LinkInvalidoError();
  const key = await importarClave(clave, 'decrypt');
  const iv = datos.subarray(MAGIA.length, MAGIA.length + 12);
  let plano: Uint8Array;
  try {
    plano = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv as BufferSource, additionalData: MAGIA },
        key,
        datos.subarray(MAGIA.length + 12) as BufferSource,
      ),
    );
  } catch {
    throw new LinkInvalidoError();
  }
  const largo = new DataView(plano.buffer, plano.byteOffset).getUint32(0);
  const cabecera = JSON.parse(new TextDecoder().decode(plano.subarray(4, 4 + largo))) as Cabecera;
  return { cabecera, pdf: plano.slice(4 + largo) };
}
