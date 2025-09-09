# Letizia Check (Electron)

App de escritorio con Electron para automatizar el flujo de cotización en WhatsApp Web, tomar capturas con Puppeteer (con fecha/hora), y programar ejecuciones cada 30 minutos.

Características:

- Login de WhatsApp dentro de la ventana (QR embebido).
- Programación exacta a HH:00 y HH:30.
- Botón para elegir carpeta de capturas.
- Captura con timestamp superpuesto.
- Verificación de Sticker inicial e Imagen final.
- Mensajes de éxito/error en la UI y notificación por WhatsApp si falla algo.

## Requisitos

- Node.js 18+
- Windows (probado en Windows; otras plataformas pueden requerir ajustes)

## Configuración

1. Copia `.env.example` a `.env` y ajusta:
	- `ALERT_CHAT_ID` número/lista de distribución para alertas.
	- `CHAT_IDS` chat(s) del bot separados por coma.
	- `CAPTURE_DIR` (opcional) ruta por defecto para capturas.

2. Instalar dependencias:

```powershell
npm install
```

## Ejecutar

```powershell
npm run dev
```

En la ventana:

- Marca "Headless" si deseas ejecutar sin UI del navegador.
- "Iniciar sesión WhatsApp" para inicializar y escanear QR.
- "Seleccionar carpeta de capturas" para elegir dónde guardar.
- "Ejecutar ahora" corre el escenario una vez.
- "Iniciar programación 30m" alinea y ejecuta cada 30m.
- "Detener programación" detiene el scheduler.

## Estructura

- `src/main` proceso principal de Electron.
- `src/preload` API segura expuesta al renderer.
- `src/renderer` UI (HTML/JS).
- `src/bot` lógica de WhatsApp y escenario.

Monitor Synthetico de Letizia
