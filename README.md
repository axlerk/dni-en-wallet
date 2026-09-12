# DNI en Wallet

Una copia de referencia del DNI argentino como pase de Apple Wallet (`.pkpass`), para tenerlo a mano en el teléfono. PWA en JavaScript puro y un endpoint de firma sin dependencias.

> **No es un documento.** El pase no tiene validez legal y no reemplaza ni al DNI de plástico ni al DNI Digital de Mi Argentina. Lleva escrito «Copia de referencia — sin validez oficial» en el dorso. El DNI Digital oficial está atado criptográficamente al dispositivo: no se puede copiar, y no es lo que se busca acá.

## Cómo funciona

1. Se saca la foto del **frente** y, si hace falta, la del **dorso**, con la cámara de la página y un marco con la proporción real de la tarjeta.
2. El código **PDF417** se busca en las dos caras, porque según la generación del DNI está adelante o atrás. Los dos formatos se reconocen por la cantidad de campos: el nuevo (2012 en adelante) trae 9 y el viejo (2009–2012) entre 16 y 17, con la fecha de vencimiento y la nacionalidad.
3. Se completan solos apellido, nombres, DNI, sexo, nacimiento, ejemplar, trámite y emisión. El CUIL se calcula con la fórmula pública (prefijo por sexo más dígito verificador módulo 11) y la nacionalidad se sugiere cuando el número está por debajo de la serie de extranjeros. Todo campo se puede corregir a mano.
4. El encuadre se ajusta en el marco: arrastrar mueve, pellizcar acerca, doble toque reinicia. Lo que se ve en el marco es lo que va al pase.
5. «Agregar a Apple Wallet» arma el pase y lo entrega al teléfono.

## La foto no sale del teléfono

El pase se arma entero en el navegador: `pass.json`, las imágenes y el zip. Al servidor viajan solo los campos del formulario y tres hashes SHA-1 de las imágenes, unos 400 bytes.

El servidor **no firma un manifest ajeno**: arma él mismo el `pass.json`, calcula los hashes de sus propios iconos y firma únicamente ese manifest. Firmar hashes a ciegas convertiría el endpoint en un oráculo de firma, donde cualquiera podría hacerse firmar un pase inventado con el certificado de Apple.

El `.pkpass` terminado lo entrega el **service worker**: la página le pasa los bytes y navega a `/pkpass/<serial>.pkpass`, que responde localmente con el `Content-Type` que Wallet espera.

`/api/sign` está limitado a 6 pedidos cada 10 segundos por IP y rechaza un `Origin` de otro sitio, para que
nadie lo use como servicio de firma ajeno.

No se guarda nada: la request entra, se firma y se responde. No hay base de datos, ni cuentas, ni cookies, ni analítica, ni un solo pedido a otro dominio.

## El pase

Estilo `storeCard`, con los colores de la bandera: celeste de fondo, el logo en amarillo y el texto en blanco. La foto del documento ocupa el strip, con las esquinas redondeadas.

Wallet dibuja adelante una sola fila de cuatro campos y descarta el resto en silencio, así que adelante van apellido, nombres, DNI y nacimiento, más sexo y ejemplar en el encabezado. Todo lo demás vive en el dorso, que se abre con el botón «•••»: el aviso legal, el nombre completo, el número de trámite, el CUIL, la nacionalidad, las fechas, el código PDF417 crudo y un enlace a Mi Argentina.

## Estructura

```
public/                 la PWA entera, y lo que también usa el servidor:
  index.html app.js styles.css sw.js manifest.webmanifest icons/ _headers
  pass-json.js          arma pass.json — una sola fuente para el pase y la vista previa
  pkpass-build.js       zip, manifest y hashes — corre igual en el navegador y en Node
  pass-assets.js        iconos del pase en base64 (generado por `npm run assets`)
  vendor/               ZXing, copiado por `npm run vendor` (no entra en git)
server/pkpass.mjs       firma PKCS#7 sobre WebCrypto, sin dependencias
server/index.mjs        servidor local: estáticos + /api/sign + /api/pass + /api/health
worker/index.mjs        el mismo endpoint en Cloudflare Workers
certs/                  wwdr.pem, signerCert.pem, signerKey.pem (no entran en git)
```

## Correrlo

```bash
npm install            # ZXing y wrangler; copia ZXing a public/vendor
cp .env.example .env   # y completarlo
npm start              # http://localhost:8787
```

Sin certificados el servidor arranca igual, la PWA funciona completa y la firma responde 503. `GET /api/health` dice si la firma está lista.

Para probar desde el teléfono hace falta **HTTPS**: un túnel temporal (`cloudflared tunnel --url http://localhost:8787`) o el sitio desplegado.

## Certificados de Apple

Hace falta una cuenta de Apple Developer.

1. Crear un **Pass Type ID** en developer.apple.com → Identifiers.
2. Generar la clave y el pedido de certificado sin pasar por Keychain:
   ```bash
   openssl req -new -newkey rsa:2048 -nodes \
     -keyout certs/signerKey.pem -out certs/pass.csr \
     -subj "/CN=DNI en Wallet Pass Type ID/O=OneGoodMan Studio/C=AR"
   ```
3. Subir `certs/pass.csr` al Pass Type ID, bajar el `.cer` y convertirlo:
   ```bash
   openssl x509 -inform der -in ~/Downloads/pass.cer -out certs/signerCert.pem
   ```
4. Bajar el certificado **WWDR G4** de apple.com/certificateauthority y convertirlo:
   ```bash
   openssl x509 -inform der -in AppleWWDRCAG4.cer -out certs/wwdr.pem
   ```

El servidor lee los certificados de `CERT_DIR` o de las variables `WWDR_PEM_B64`, `SIGNER_CERT_PEM_B64` y `SIGNER_KEY_PEM_B64`, que tienen prioridad y sirven para un hosting sin disco.

## Despliegue

Cloudflare Workers sirve la PWA como Static Assets y el Worker atiende `/api/*`. Cada push a `main` dispara una build que despliega sola; también funciona `npm run deploy` a mano. Los certificados se cargan como secrets con `npm run secrets`.

Las cabeceras de seguridad están en `public/_headers`: HSTS, CSP, `nosniff`, `no-referrer`, COOP, CORP y una política de permisos que deja la cámara solo para esta página.

## Lo que falta probar en un iPhone

- La hoja de Wallet desde el modo **pantalla de inicio**. Desde Safari funciona; en standalone hay que confirmarlo.
- La lectura del PDF417 con **fotos reales**, con brillos y en ángulo.
- La orientación EXIF en iOS viejos.

## Privacidad y límites

Los datos salen únicamente del documento que tiene el usuario en la mano: el código de barras y sus propias fotos. **Nunca se consulta un número de DNI contra ningún padrón**, ni se buscan datos de terceros. La tarjeta tiene un diseño propio a propósito: es una copia de referencia, no un facsímil del documento oficial.
