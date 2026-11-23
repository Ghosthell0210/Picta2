# Guía Rápida de Despliegue en Altare (`altr.cc`)

Todo el proyecto está listo para subir a GitHub y desplegar en **Altare** sin cambios de código y sin ninguna credencial expuesta en el repositorio.

## Opción 1: Despliegue con Dockerfile (Recomendado)

Incluye **Node 22 Slim + `ffmpeg` + `unzip` + `tar`** preinstalados y verificación automática de salud (`/api/health`).

1. **Sube el proyecto a un repositorio privado en GitHub** (`.gitignore` ya excluye `.env`, `data/` y `server.js`).
2. **Crea el servicio en Altare conectando tu repositorio** y selecciona despliegue por **`Dockerfile`**.
3. **Monta el volumen persistente** en la ruta:
   - `/app/data`
4. **Agrega tus variables de entorno** en el panel de secretos de Altare:

```env
NODE_ENV=production
PORT=3000
TELEGRAM_MODE=polling
TELEGRAM_BOT_TOKEN=<token_de_botfather>
MASTER_ADMIN_CHAT_ID=<tu_telegram_user_id>
TELEGRAM_API_ID=<tu_api_id>
TELEGRAM_API_HASH=<tu_api_hash>
TELEGRAM_VAULT_CHAT_ID=<id_del_canal_privado_boveda_opcional>
VAULT_ENCRYPTION_KEY=<clave_aleatoria_min_32_caracteres>
PICTA_USERNAME=<usuario_o_telefono_picta>
PICTA_PASSWORD=<password_picta>
PICTA_CLIENT_ID=<client_id_oauth_picta>
PICTA_AES_KEY=<clave_aes_128_picta>
PICTA_CHANNEL_ID=36319
PICTA_CHANNEL_NAME=Multiverso Visual
TMDB_API_KEY=<tu_tmdb_api_key_opcional>
ADMIN_DASHBOARD_PASSCODE=<clave_de_acceso_al_panel_web>
PICTA_STATE_DIR=/app/data/bot_state
PICTA_SCRATCH_DIR=/app/data/scratch
PICTA_DISK_BUDGET_GB=10
MTPROTO_SAFE_PARALLEL_WORKERS=6
MTPROTO_TCP_POOL_SIZE=6
MAX_PREFETCH_LOOKAHEAD=1
```

5. **Despliega**: el contenedor compila `dist/` + `server.js` automáticamente y arranca con `node server.js`.

---

## Opción 2: Contenedor Node.js directo (sin Docker)

Si tu plan en Altare usa un contenedor Node.js 22 estándar:

- **Build command**: `npm install && npm run build`
- **Start command**: `npm start`
- **Variables de almacenamiento**:
  - `PICTA_STATE_DIR=./data/bot_state`
  - `PICTA_SCRATCH_DIR=./data/scratch`
- El servidor detecta automáticamente `PORT` o `SERVER_PORT` asignado por el panel.

---

## Migración de usuarios y sesión MTProto desde Cloud Run

- Si ya tenías respaldos guardados en la bóveda de Telegram (`setMyCommands` scopes `eo`/`ia`), solo configura `TELEGRAM_BOT_TOKEN`, `MASTER_ADMIN_CHAT_ID` y `PICTA_AES_KEY` en Altare y ejecuta **`/restaurar_nube`** en el bot o pulsa **Restaurar de Telegram (eo/ia)** en la pestaña **Bóveda y Altare**.

## Notas rápidas de operación

- **Long Polling 24/7** es el modo por defecto; no necesitas configurar dominio HTTPS salvo que cambies `TELEGRAM_MODE=webhook` y definas `APP_URL` + `TELEGRAM_WEBHOOK_SECRET`.
- Puedes generar claves aleatorias seguras para `VAULT_ENCRYPTION_KEY` y `ADMIN_DASHBOARD_PASSCODE` con un clic desde la pestaña **Bóveda y Altare** de la consola web.
- Mantén `MTPROTO_SAFE_PARALLEL_WORKERS` entre `6` y `8` y `MAX_PREFETCH_LOOKAHEAD=1` para operar estable con 10 GB de disco y CPU compartida.
