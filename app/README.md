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

## Desplegar (para usarlo en el móvil este finde)
Cualquier hosting estático con HTTPS sirve. Sin build, son ficheros estáticos.

**Vercel**
```bash
npm i -g vercel
cd app && vercel --prod
```

**Netlify** (arrastra la carpeta `app/` en app.netlify.com/drop, o):
```bash
npm i -g netlify-cli
cd app && netlify deploy --prod --dir .
```

**GitHub Pages**: publica el contenido de `app/` y entra por la URL `https://…`.

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

## Estructura
```
app/
├── index.html      # 5 pantallas (inicio, meta, HUD, resumen, ajustes)
├── app.css         # estilos según el brief de marca Trazza
├── app.js          # GPS, geometría de meta, detección de vuelta, estado, export
├── sw.js           # service worker (offline app shell)
├── manifest.webmanifest
└── icons/          # iconos PWA + generador sin dependencias (gen-icons.js)
```

## Notas técnicas
- Geometría en proyección equirectangular local (metros) alrededor de la meta.
- El cruce solo cuenta en el **sentido de marcha** (producto escalar con la normal),
  para no contar la vuelta al pasar por la recta en sentido contrario.
- Intervalo medio abierto en la fracción del segmento para evitar dobles cruces.
- `Ajustes → Vuelta mínima` descarta rebotes de GPS (por defecto 20 s).
- La geometría está cubierta por pruebas aisladas (ver historial del repo).
