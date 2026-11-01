# Firma de documentos ✍️

Página para que un cliente firme a mano un PDF desde el celular o la computadora.

- **Página de firma (cliente):** https://pablorodriguez1981-netizen.github.io/firma/
- **Panel del estudio:** https://pablorodriguez1981-netizen.github.io/firma/estudio/
- **Preparar un documento (estudio):** https://pablorodriguez1981-netizen.github.io/firma/#preparar

## Qué hace el cliente

Lee el documento, escribe sus datos en un campo libre de varias líneas (nombre, DNI, domicilio…) y firma con el dedo o el mouse. Puede ser:

- **Una firma**, en la hoja que elija (por defecto, la última).
- **Todas las hojas**: firma una vez **por cada hoja**, por separado (Firma 1 → Siguiente/Enter → Firma 2 → …), así cada firma es distinta y no una copia de la misma imagen. Si son 18 hojas, son 18 firmas.
- **Elegir**: una o varias firmas donde quiera (incluso varias en la misma hoja).

Cada firma, con los datos debajo (y la fecha y hora, opcional), se arma como una imagen PNG que se inserta en el PDF. **Se ubica sola debajo de donde termina el texto** de cada hoja: analiza la hoja (funciona también con documentos escaneados) e ignora el número de página del pie. Si no entra, prueba más chica y después busca otro lugar libre; si no hay ninguno, lo avisa con ⚠️. Cada firma se puede **mover** arrastrándola (o tocando la hoja donde se la quiere), alinear a izquierda, centro o derecha y cambiar de tamaño. Hay modo pantalla completa para firmar en el celular.

Al terminar, descarga o comparte (WhatsApp, mail) el PDF firmado y, si quiere, las imágenes de las firmas (un ZIP si son varias). Las hojas giradas o de distinto tamaño se firman en la posición correcta.

## Mandar un documento con un link

1. En el **panel del estudio**, conectá GitHub una sola vez con un *fine-grained token*: Repository access › *Only select repositories* › este repositorio; Permissions › **Contents: Read and write**. El token queda guardado sólo en ese navegador.
2. **Preparar documento**: elegí el PDF, marcá cuántas firmas y dónde (se ubican solas debajo del texto y las podés mover), escribí el título y las indicaciones y generá el link. Por defecto el cliente no puede cambiar cuántas firmas ni en qué hojas (sí correrlas un poco si tapan algo).
   **Subida rápida**: subí uno o varios PDF sin marcar lugares (sugerencia: una firma en la última hoja o una en cada hoja) y el cliente decide.
3. Copiá el link (o mandalo por WhatsApp desde el panel). El cliente lo abre, firma y te devuelve el PDF firmado.

Cada PDF se **cifra en el navegador** (AES-GCM de 256 bits) antes de subirse a la rama `firmas-casos` de este repositorio. La clave va sólo en el link, después del `#`, que los navegadores no envían a ningún servidor: en el repositorio público queda únicamente el archivo cifrado. Desde el panel se puede borrar cada documento cuando ya no haga falta.

**Sin subir nada:** abrí la página de firma, elegí el PDF desde el dispositivo y pasale el teléfono o la tablet al cliente. En ese modo el archivo nunca sale del navegador.

> Es una **firma electrónica** (firma manuscrita digitalizada), no una *firma digital* con certificado en los términos de la Ley 25.506. Si el PDF ya tenía firmas digitales, al agregarle la firma dejan de verificarse (la página lo avisa). Los PDF protegidos con contraseña o contra cambios no se pueden firmar.

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
  cifrado.ts, enlace.ts, github.ts, almacen.ts   links cifrados y subida a GitHub
  zip.ts              ZIP de las imágenes de las firmas
```
