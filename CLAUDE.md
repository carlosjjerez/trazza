# Trazza — contexto del proyecto

Cronómetro GPS de vueltas para **moto en circuito**, en **español**, como PWA.
«El Strava del motorsport sobre dos ruedas». Marca y tono en `trazza-brand.md`.

## FOCO ACTUAL (léelo primero)
- **Solo GPS del móvil (~1 Hz).** Trabajamos únicamente la app web/PWA con la
  geolocalización del teléfono.
- **El hardware está APARCADO.** Toda la vía de dispositivo propio (ESP32 +
  u-blox / IMU / lean angle / 25 Hz / BLE / Wi-Fi) queda **fuera de alcance por
  ahora**. No añadas código, pantallas ni dependencias de hardware. Está
  documentado en `research/` solo como referencia futura; no lo implementes.
- Honestidad de datos: el móvil da **décimas fiables, no centésimas**. No
  prometas precisión que la fuente no da; muestra siempre precisión/estado real.

## Dónde está cada cosa
- `app/` — la PWA (todo el producto actual). Sin build, ficheros estáticos.
  - `index.html` — 5 pantallas: inicio, meta, HUD, resumen, ajustes + builder + modo track.
  - `app.css` — estilos; tokens de paleta de marca en `:root`.
  - `app.js` — GPS, sesión, delta predictivo, mini-mapa, récord (PB), recordatorios,
    modo track horizontal, export, ajustes.
  - `detect.js` — **núcleo puro y testeado** de detección de vueltas (no tocar sin tests).
  - `analyze.js` — **núcleo puro y testeado** de análisis de tanda (segmentar vueltas,
    perfil y delta por distancia, reparto por sectores, constancia). `require`-able desde Node.
  - `sensors.js` — **núcleo puro y testeado** de sensores: inclinación (lean) por filtro
    complementario + fuerzas G con el IMU del PROPIO móvil (no hardware externo). El mapeo
    de ejes DeviceMotion→moto vive en `app.js` (`IMU_AXES`) y se calibra en pista.
  - `sim.js` — simulador de GPS para el **modo demo** (probar sin pista).
  - `cartagena-track.js` — trazado real de Cartagena (meta + outline), ya en sentido correcto.
  - `sw.js` — stub que se auto-desinstala (NO reintroducir service worker).
- `app/README.md` — documentación de uso, detección, pruebas y despliegue.
- `trazza-brand.md` — marca: paleta, tipografía, tono de voz, logo.
- `research/` — investigación competitiva + hardware (REFERENCIA, no es alcance actual).
- `design/` — maquetas de diseño antiguas (referencia visual).

## Cómo ejecutar / probar / desplegar
```bash
# Ejecutar en local (la geolocalización exige localhost o https)
cd app && python3 -m http.server 8080      # http://localhost:8080
#   Ajustes → Pruebas → Modo demo  (ver el HUD dar vueltas sin GPS real)

# Pruebas (node, sin dependencias salvo dom-smoke)
cd app
node test/detect-test.js    # núcleo de detección (incluye caso 250 km/h)
node test/sim-test.js       # modo demo de extremo a extremo
npm i jsdom && node test/dom-smoke.js   # arranca la app real y simula una sesión

# Desplegar (Vercel, sin build, Root Directory = app)
cd app && vercel --prod
```
Tras tocar lógica de detección o de sesión, **corre los tests** antes de dar algo por hecho.

## Invariantes y convenciones (no romper)
- **Detección**: la meta es un **punto + radio** (sin rumbo); el cruce se interpola
  punto-a-segmento; hay bloqueo de sentido y vuelta mínima. Todo en `detect.js`,
  cubierto por tests y también `require`-able desde Node. Cambios aquí → añade/pasa tests.
- **Delta predictivo** se calcula por **distancia recorrida** vs vuelta de referencia
  (récord, o mejor de la sesión si aún no hay récord), no por tiempo.
- **Sin service worker.** Decisión consciente (fiabilidad de carga en iOS). No hay
  modo offline; se abre la app con cobertura. No reintroducir `sw.js` con handler `fetch`.
- **Cache busting**: los assets se enlazan con `?v=YYYYMMDD…`; al cambiar `.css`/`.js`
  sube la versión del query string (iOS cachea agresivo). `vercel.json` ya pone no-cache
  a `/`, `.css`, `.js`.
- **Paleta** (marca, dark-first): asfalto `#0E0F12`, grafito `#1C1F26`, **hi-viz
  `#B6FF1A`** (acento/mejor/delta+), cian `#1FE0C8` (datos en vivo), ámbar `#FF9E1B`
  (en curso/PB), rojo `#FF3B30` (crítico/delta−), blanco `#F5F7FA`, niebla `#8A93A6`.
  Verde = vas más rápido; rojo = más lento. Tiempos en cifras tabulares (héroe visual).
- **Tono**: tuteo, español neutro, colega motero experto, frases cortas, honesto con los datos.
- **Persistencia**: hoy en `localStorage` con claves `trazza.*.v*` (settings, sessions,
  metas, circuits, records, reminders). ⚠️ Deuda conocida: `localStorage` NO escala para
  telemetría; si se registran muestras densas, migrar a **IndexedDB** (no ampliar el uso
  de localStorage para datos pesados).

## Estado actual (funciona)
Cronómetro con detección automática, sectores en vivo, delta predictivo verde/rojo,
mini-mapa del circuito en el HUD, crear circuitos (GPS o punto a punto), preset Cartagena
y plantilla de maniobras, récord histórico (PB) por circuito, recordatorios por vuelta,
modo track horizontal (pantalla verde/roja), resumen con mapa y zoom, export CSV/GPX,
avisos (pitido/vibración/wake-lock), km/h o mph, modo demo. Instalable como PWA.
**Análisis de tanda**: desde el resumen, comparar dos vueltas (A vs B) con cabecera
narrativa «dónde está la vuelta», delta por distancia (área verde/roja) y velocidad por
distancia; todo por distancia recorrida, con nota de honestidad. Núcleo en `analyze.js`.
**Inclinación (lean) + G con el IMU del móvil** (opt-in en Ajustes): HUD en vivo y máximos
(IZQ/DER y G) en el resumen; calibración al salir a pista. Núcleo en `sensors.js`. Se guarda
alineado al fix GPS (1 Hz) + máximos, sin inflar `localStorage`.

## Ideas de siguiente paso (solo móvil; confirmar con el usuario antes de construir)
Guía de adaptación competitiva (vs Lap360): teardown en `research/` cuando se mueva ahí.
- Análisis de tanda v2: trazada sobre satélite coloreada por velocidad/pérdida de tiempo,
  gráficas metro a metro con zoom sincronizado al mapa, curva a curva, comparar >2 vueltas.
- Inclinación + G (IMU): v1 HECHA (HUD + máximos). Pendiente v2: afinar `IMU_AXES` y el
  signo del roll en MOTO REAL (depende del soporte); lean/G por distancia en el análisis;
  corrección por ancho de neumático con geometría real; muestreo denso → **IndexedDB**
  antes de guardar streams a >1 Hz (localStorage no escala).
- Garaje: motos, mantenimiento por horas de motor, fichas de reglaje, mejor tiempo por reglaje.
- Home dashboard (sesiones/km/vueltas/récord) y lista de sesiones mejorada.
- Liga/comunidad/quedadas → backend (Supabase disponible); fase mayor, cuentas incluidas.
- Mejoras de precisión con GPS de móvil (suavizado, filtrado de outliers del fix).

## Git / trabajo
- Rama de desarrollo: **`main-9znyue`** (crear en local desde el último default si no existe).
- No crear Pull Requests salvo que el usuario lo pida explícitamente.
- `VERCEL_TOKEN` y el email del usuario son privados: nunca exponerlos a servicios externos.
