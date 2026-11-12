# Trazza · Cronómetro de pista (MVP PWA)

Cronometraje GPS de vueltas para moto en circuito, en español. Usa el **GPS del
móvil (~1 Hz)** y detecta el paso por meta por **aproximación al punto + interpolación
sub-muestra**, dando tiempos a nivel de **décimas**.

> Honestos con los datos: el móvil entrega ~1 Hz, así que esto da décimas fiables,
> **no centésimas**. Las centésimas llegan con el hardware v2 (ESP32 + u-blox M10 a
> 10 Hz), que alimentará **esta misma app** (mismo modelo de detección).

## Cómo funciona la detección (rediseño function-first)
La meta es un **punto** con un **radio de captura** (no una línea con rumbo). Cada
vuelta se cierra en el instante de **máxima aproximación** a ese punto a lo largo de
la trayectoria:

- **Sin rumbo**: no hay que orientar ninguna línea (antes, marcar parado dejaba la
  meta mal orientada — bug eliminado).
- **Interpolación punto-a-segmento**: el tiempo de cruce es exacto aunque a 250 km/h
  ningún fix caiga dentro del radio (el *segmento* entre fixes sí pasa por la meta).
- **Bloqueo de sentido**: descarta pasos en dirección contraria (boxes, vuelta de
  reconocimiento).
- **Vuelta mínima**: anti-rebote configurable.

Todo el núcleo (`detect.js`) está cubierto por pruebas (ver `test/`).

## Funciones
- Estado GPS prominente y a color (precisión, frecuencia, calidad de fix).
- **Crear circuitos**: grabándolos por GPS (das una vuelta y se dibuja solo) o
  **punto a punto** (fijas meta y pineas puntos). Se guardan y se reutilizan.
- **Mapa del circuito en vivo en el HUD**: al cronometrar, arriba se ve el
  trazado y tu posición moviéndose por él en tiempo real, con los puntos de sector.
- Marcar meta en tu posición o elegir circuito (preset **Cartagena** `37.6444,-1.0352`).
- Plantilla **Circuito de maniobras** (conos, reconstruida desde sus cotas): se
  coloca en tu posición al marcar la meta; solo hay que asignar la meta y rodar.
- **Mini-mapa** en vivo para confirmar posición/meta y el track de la sesión.
- HUD: vuelta en curso, **delta predictivo por distancia vs tu récord** (o vs tu
  mejor de la sesión si aún no hay récord), última, mejor, velocidad y máx.
- **Récord histórico (PB) por circuito**: guarda tu mejor marca de siempre, avisa
  al batirla en pista y la compara en el resumen y en la pantalla de meta.
- **Recordatorios por vuelta**: antes de la tanda apunta avisos (texto + nº de
  vuelta, p. ej. «mirar temperatura en la vuelta 3») y saltan en el HUD al entrar
  en esa vuelta.
- **Modo track (horizontal)**: al girar el móvil, el HUD se simplifica — tiempo en
  curso grande arriba, vueltas/tanda/anterior/mejor pequeños, y la pantalla entera
  se pone **verde si vas más rápido** o **roja si más lento** que tu vuelta rápida,
  con la diferencia en segundos y décimas, recalculada al cruzar cada sector.
- **Resumen de inicio**: tarjeta «Tu resumen» (sesiones, vueltas, km en pista, mejor
  récord global) y lista de sesiones con moto y km por tanda.
- Resumen con todas las vueltas, mejor resaltada, mapa del track (con zoom) y export.
- **Análisis de tanda** (comparar vueltas): desde el resumen, «Analizar tanda» abre
  una pantalla que **compara dos vueltas** (A vs B) con cabecera **narrativa**
  («dónde está la vuelta»: reparto por sectores, verde ganas / rojo pierdes),
  **delta por distancia** (área verde/roja) y **velocidad por distancia** (A/B
  superpuestas). Todo por **distancia recorrida**, coherente con el delta en vivo,
  y con nota de honestidad (décimas, no centésimas). Núcleo puro en `analyze.js`.
  Si la tanda registró sensores, añade **inclinación por distancia** (A/B); y el mapa del
  resumen se puede colorear por **velocidad o inclinación** (toggle + leyenda).
- **Inclinación (lean angle) y fuerzas G** con el **IMU del propio móvil**
  (acelerómetro + giroscopio, `DeviceMotion` ~60 Hz; sin hardware externo).
  Filtro complementario (el acelerómetro solo se equivoca en curva, así que el
  giroscopio lleva la voz y el acelerómetro corrige deriva en recto). Se calibra
  al salir a pista (0° con la moto recta). En el HUD en vivo y máximos (IZQ/DER y
  G) en el resumen. Opt-in en Ajustes. Núcleo puro en `sensors.js`.
  Honestidad: grados orientativos del móvil, no telemetría profesional; el ajuste
  fino de ejes depende del soporte y se calibra en moto real.
- **Garaje**: tus **motos** (marca/modelo, cc, CV, kg, categoría, **horas de motor**),
  **mantenimiento por horas** (aceite, cadena, pastillas, líquido, horquilla, válvulas
  con intervalo, barra «faltan X h» y botón «Hecho»), **fichas de reglaje** (clics de
  suspensión, presiones, alturas…) y **mejor tiempo por reglaje** por circuito. Antes de
  la tanda eliges **moto + reglaje**; las horas de motor se suman solas al terminar.
  Núcleo puro en `garage.js`.
- Export **CSV** (vueltas) y **GPX** (track crudo, red de seguridad).
- Avisos: pitido, vibración y *wake lock* (pantalla siempre encendida). km/h o mph.
- **Modo demo** (GPS simulado) para probar sin pista.
- Instalable como PWA. **Sin service worker** (decisión consciente: máxima fiabilidad
  de carga en iOS; a cambio, no hay modo offline — abre la app con cobertura).

## Probar en local
La geolocalización exige contexto seguro (`https://` o `http://localhost`).
```bash
cd app
python3 -m http.server 8080   # http://localhost:8080
```
En el navegador puedes usar **Ajustes → Pruebas → Modo demo** para ver el HUD dar
vueltas solo, sin GPS real.

## Desplegar en Vercel
Sin build (ficheros estáticos), HTTPS automático. `vercel.json` fija los headers.
```bash
npm i -g vercel
cd app
vercel --prod
```
O dashboard: importa el repo → **Root Directory = `app`** → Framework *Other*.

## Instalar en el iPhone
1. Abre la URL **https** en **Safari**.
2. Compartir → **Añadir a pantalla de inicio**.
3. Ábrela desde el icono y **concede la ubicación** ("Al usar la app").

## Protocolo en pista (Cartagena)
1. Llega con cobertura (no hay offline) y abre la app.
2. Espera a **FIX BUENO** (±≤8 m). En la zona de meta, pulsa **Marcar meta en mi
   posición** (o elige el preset Cartagena).
3. **Salir a pista**. El crono arranca en tu **primer** paso por meta.
4. Rueda ≥6–10 vueltas. Para terminar: **FIN**.
5. Exporta **CSV** y **GPX**.
6. **Red de seguridad:** corre en paralelo RaceChrono / Harry's LapTimer y compara.

## Estructura
```
app/
├── index.html      # 5 pantallas: inicio, meta, HUD, resumen, ajustes
├── app.css         # estilos (paleta de marca Trazza)
├── app.js          # GPS, sesión, delta predictivo, mini-mapa, export, ajustes
├── detect.js       # núcleo de detección de vueltas (puro, testeable)
├── analyze.js      # núcleo de análisis de tanda (puro, testeable)
├── sensors.js      # núcleo de sensores: lean angle + G del móvil (puro, testeable)
├── garage.js       # núcleo del garaje: mantenimiento, horas, mejor por reglaje (puro)
├── sim.js          # simulador de GPS (modo demo)
├── sw.js           # stub que se auto-desinstala (sana versiones antiguas)
├── vercel.json     # headers de despliegue estático
├── manifest.webmanifest
├── icons/          # iconos PWA + generador sin dependencias (gen-icons.js)
└── test/           # pruebas (node, sin deps salvo dom-smoke)
```

## Pruebas
```bash
cd app
node test/detect-test.js   # núcleo de detección (incluye caso 250 km/h)
node test/analyze-test.js  # núcleo de análisis (segmentar, delta por distancia, constancia)
node test/sensors-test.js  # núcleo de sensores (lean complementario, G, calibración)
node test/garage-test.js   # núcleo del garaje (mantenimiento por horas, mejor por reglaje)
node test/sim-test.js      # modo demo de extremo a extremo
npm i jsdom && node test/dom-smoke.js   # arranca la app real y simula una sesión + análisis
```
