# Firma de documentos ✍️

Página para que un cliente firme a mano un PDF desde el celular o la computadora.

- **Página de firma (cliente):** https://pablorodriguez1981-netizen.github.io/firma/
- **Panel del estudio:** https://pablorodriguez1981-netizen.github.io/firma/estudio/
- **Preparar un documento (estudio):** https://pablorodriguez1981-netizen.github.io/firma/#preparar

## Cómo funciona

1. **Preparás el documento** desde el panel: elegís el PDF y cuántas firmas lleva (una, una distinta en cada hoja, o donde marques). Cada firma se ubica sola **debajo de donde termina el texto** de la hoja (analiza la hoja, así que anda también con escaneados, e ignora el número de página del pie); si no entra, prueba más chica o busca otro lugar libre y, si no hay ninguno, lo avisa con ⚠️. Podés mover cada firma, alinearla y cambiarle el tamaño.
2. **Le mandás el link al cliente** (WhatsApp o mail).
3. **El cliente sólo ve el documento, un campo para sus datos** (nombre, DNI, lo que quiera, en varias líneas) **y el recuadro para firmar** con el dedo. Si son varias firmas, firma cada una por separado (Firma 1 → Siguiente/Enter → Firma 2 → …): cada firma es distinta, no una copia. Toca «Firmar y enviar al estudio».
4. **El documento firmado te llega al panel**: aparece «✅ Firmado», con quién firmó, y lo descargás. El cliente no tiene que mandarte nada (igual puede bajarse una copia). Si no se pudiera guardar, se le avisa y puede descargarlo y mandártelo.

Cada firma, con los datos debajo y la aclaración en chiquito «Firmado digitalmente el … a las … h», se inserta como imagen en el PDF. Las hojas giradas o de distinto tamaño se firman en la posición correcta.

## Configuración (una sola vez)

1. Creá un repositorio **privado** llamado `firma-datos` (https://github.com/new, sin README). Ahí se guardan, cifrados, los documentos que mandás y los firmados.
2. Creá un *fine-grained token* (https://github.com/settings/personal-access-tokens/new): Repository access › *Only select repositories* › **sólo `firma-datos`**; Permissions › **Contents: Read and write**.
3. En el **panel del estudio**, pegá el token y tocá «Guardar y probar».

### Seguridad

- Cada PDF se **cifra en el navegador** (AES-GCM de 256 bits) antes de subirse; el firmado vuelve cifrado con la misma clave. La clave va sólo en el link, después del `#`, que los navegadores no envían a ningún servidor.
- Para que el cliente pueda guardar el firmado, el link lleva el permiso de GitHub **cifrado** con la clave del documento. Por eso el token tiene que tener acceso **sólo** a `firma-datos` (nunca al repositorio de la página): quien tenga un link puede escribir ahí, pero no leer los documentos de otros, que van cifrados con otras claves.
- Si revocás o cambiás el token, los links ya enviados dejan de funcionar (generá links nuevos).
- La lista de documentos con sus claves queda en el navegador donde los generaste: descargá los firmados desde ese mismo navegador.

**Sin subir nada:** abrí la página de firma, elegí el PDF desde el dispositivo y pasale el teléfono o la tablet al cliente. En ese modo el archivo nunca sale del navegador.

> Técnicamente es una **firma electrónica** (firma manuscrita digitalizada), no una *firma digital* con certificado en los términos de la Ley 25.506, aunque la aclaración diga «Firmado digitalmente». Si el PDF ya tenía firmas digitales, al agregarle la firma dejan de verificarse (la página lo avisa). Los PDF protegidos con contraseña o contra cambios no se pueden firmar.

## Desarrollo

```bash
npm install
npm run dev     # servidor de desarrollo
npm test        # tests (geometría, ubicación automática, cifrado, estampado, zip)
npm run build   # typecheck + build de producción
```

Cada push a `main` se prueba, se compila y se publica en GitHub Pages (`.github/workflows/publicar.yml`, rama `gh-pages`).

```
index.html            página de firma (cliente y #preparar del estudio)
estudio/index.html    panel del estudio
src/
  cliente.ts          página de firma
  estudio.ts          panel del estudio
  autoubicar.ts       dónde termina el texto y dónde va cada firma
  ubicacion.ts        geometría (hojas giradas o de distinto tamaño)
  estampar.ts         inserta las firmas en el PDF (pdf-lib)
  visor.ts            muestra y analiza las hojas (pdf.js)
  imagen.ts           arma la imagen de cada firma con los datos
  cifrado.ts, enlace.ts, github.ts, almacen.ts   links cifrados y documentos en firma-datos
  zip.ts              ZIP de las imágenes de las firmas
```
