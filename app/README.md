# Trazza · Cronómetro de pista (MVP PWA)

Cronometraje GPS de vueltas para moto en circuito, en español. Esta es la PWA del
MVP: usa el **GPS del móvil (~1 Hz)** y detecta el paso por meta con un algoritmo de
**cruce de segmento + interpolación temporal**, dando tiempos a nivel de **décimas**.

> Honestos con los datos: el móvil entrega ~1 Hz, así que esto valida el concepto y
> da décimas fiables, **no centésimas**. Las centésimas llegan con el hardware v2
> (ESP32 + u-blox M10 a 10 Hz por WiFi), que alimentará **esta misma app**.

## Qué hace
- Captura GPS continua con `watchPosition` (alta precisión).
- **Marcar meta aquí**: fija la línea de meta en tu posición y rumbo actuales.
  Preset incluido: **Circuito de Cartagena** (`37.6444, -1.0352`).
- Detección de vuelta por intersección del segmento entre dos fixes con la línea de
  meta, con interpolación del instante exacto del cruce (sub-muestra).
- HUD en vivo: vuelta en curso, última, mejor, delta vs mejor, velocidad y máx.
- Resumen de sesión con todas las vueltas y la mejor resaltada.
- Exportación **CSV** (vueltas) y **GPX** (track crudo, red de seguridad).
- Avisos: pitido, vibración y *wake lock* (pantalla siempre encendida).
- Funciona **offline** una vez abierta con conexión (service worker).
- Ajustes: ancho de línea, vuelta mínima (anti-rebote), unidades km/h / mph.

## Probar en local
Sirve la carpeta `app/` por HTTP (la geolocalización exige contexto seguro:
`https://` o `http://localhost`).

```bash
cd app
python3 -m http.server 8080
# abre http://localhost:8080
```

En escritorio puedes simular posiciones desde las DevTools (Sensors → Location),
pero la prueba real es en el móvil.

## Desplegar en Vercel (para usarlo en el móvil este finde)
Sin build: son ficheros estáticos y HTTPS es automático. La config de despliegue
(`vercel.json`) ya fija los headers correctos de PWA (service worker sin caché,
`Service-Worker-Allowed: /` y el MIME del manifest).

**Opción A — CLI (desde la carpeta `app/`):**
```bash
npm i -g vercel
cd app
vercel --prod
```
La primera vez confirma el proyecto; despliega el contenido de `app/` tal cual.

**Opción B — Dashboard (conectando el repo de GitHub):**
1. En vercel.com → *Add New Project* → importa `carlosjjerez/trazza`.
2. En *Configure Project* pon **Root Directory = `app`**.
3. Framework Preset: *Other*; sin Build Command ni Output Directory (es estático).
4. *Deploy*. Te da una URL `https://…vercel.app`.

Para futuras versiones: `git push` y Vercel redespliega solo (Opción B), o repite
`vercel --prod` (Opción A).

## Instalar en el iPhone
1. Abre la URL **https** en Safari.
2. Compartir → **Añadir a pantalla de inicio**.
3. Ábrela desde el icono (pantalla completa, sin barra del navegador).
4. La primera vez, **concede el permiso de ubicación** ("Al usar la app").

## Protocolo en pista (Cartagena)
1. Llega con cobertura y **abre la app una vez** para que cachee (luego va offline).
2. En la zona de meta, espera a **FIX LISTO** (±≤8 m) y pulsa **Marcar meta aquí**
   mientras avanzas en el sentido de carrera (así fija bien el rumbo). O elige el
   preset de Cartagena.
3. **Empezar sesión**, monta el móvil y sal. El crono arranca en tu **primer** paso
   por meta.
4. Rueda ≥6–10 vueltas. Para terminar: **FIN**.
5. Exporta **CSV** y **GPX**.
6. **Red de seguridad recomendada:** corre en paralelo RaceChrono / Harry's LapTimer
   y compara, para validar la repetibilidad del MVP.

## Modo demo (probar el HUD sin salir a pista)
En **Ajustes → Pruebas → Modo demo (GPS simulado)** la app deja de usar el GPS real
y un simulador da vueltas solo alrededor de la meta, cruzándola en el sentido
correcto cada ~45 s. Sirve para ver el HUD en vivo, la detección de vueltas, la
mejor vuelta, el delta y la exportación funcionando antes del finde.

Flujo: activa el modo demo → *Nueva sesión* → elige el preset **Cartagena** (o
*Marcar meta aquí*) → *Empezar sesión*. Verás registrarse vueltas cada ~45 s.

> Por seguridad, el modo demo **nunca se guarda**: al recargar la app vuelve
> siempre al GPS real. No lo dejes puesto pensando que cronometra de verdad.

## Estructura
```
app/
├── index.html      # 5 pantallas (inicio, meta, HUD, resumen, ajustes)
├── app.css         # estilos según el brief de marca Trazza
├── app.js          # GPS, geometría de meta, detección de vuelta, estado, export
├── sim.js          # simulador de GPS (modo demo)
├── sw.js           # service worker (offline app shell)
├── vercel.json     # config de despliegue estático (headers PWA)
├── manifest.webmanifest
├── icons/          # iconos PWA + generador sin dependencias (gen-icons.js)
└── test/           # pruebas de geometría y del simulador (node, sin deps)
```

## Pruebas
```bash
cd app
node test/geo-test.js   # geometría de detección de meta (10/10)
node test/sim-test.js   # modo demo de extremo a extremo (vueltas detectadas)
```

## Notas técnicas
- Geometría en proyección equirectangular local (metros) alrededor de la meta.
- El cruce solo cuenta en el **sentido de marcha** (producto escalar con la normal),
  para no contar la vuelta al pasar por la recta en sentido contrario.
- Intervalo medio abierto en la fracción del segmento para evitar dobles cruces.
- `Ajustes → Vuelta mínima` descarta rebotes de GPS (por defecto 20 s).
- La geometría está cubierta por pruebas aisladas (ver historial del repo).
