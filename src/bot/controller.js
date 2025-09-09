const path = require('path');
const fs = require('fs');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const sharp = require('sharp');
require('dotenv').config();

const DEFAULT_ALERT_CHAT_ID = process.env.ALERT_CHAT_ID || '202284772376688@lid';
const CHAT_IDS = (process.env.CHAT_IDS || '104977657778311@lid').split(',').map(s => s.trim());
const getNumberFromJid = (jid) => (jid || '').toString().split('@')[0];
const TARGET_NUMBERS = new Set(CHAT_IDS.map(getNumberFromJid));

function nextHalfHourDate() {
  const now = new Date();
  now.setSeconds(0, 0);
  const m = now.getMinutes();
  if (m < 30) now.setMinutes(30); else { now.setMinutes(0); now.setHours(now.getHours() + 1); }
  return now;
}

class BotController {
  constructor({ sendToRenderer }) {
    this.sendToRenderer = sendToRenderer;
    this.client = null;
    this.captureDir = process.env.CAPTURE_DIR || path.join(process.cwd(), 'captures');
    if (!fs.existsSync(this.captureDir)) fs.mkdirSync(this.captureDir, { recursive: true });
    this.scheduler = null;
    this.browserPath = null; // gestionado por whatsapp-web.js/puppeteer internamente
  this.activeChatIds = new Set(); // JIDs que respondieron (c.us/lid)
  }
  
  // Utilidad: normaliza texto para comparaciones flexibles (sin acentos, sin puntuación, colapsando espacios)
  _normalize(s) {
    if (!s) return '';
    return s
      .toString()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quitar acentos
      .replace(/[\*\_`]/g, '') // quitar markdown simple
      .toLowerCase()
      .replace(/[^a-z0-9ñáéíóúü¿?\s]/gi, ' ') // dejar letras/numeros/espacios y ¿?
      .replace(/\s+/g, ' ')
      .trim();
  }

  _includesNormalized(haystack, needle) {
    const h = this._normalize(haystack);
    const n = this._normalize(needle);
    return h.includes(n);
  }

  setCaptureDir(dir) {
    this.captureDir = dir;
    if (!fs.existsSync(this.captureDir)) fs.mkdirSync(this.captureDir, { recursive: true });
    this.sendToRenderer('status', `Directorio de capturas establecido: ${dir}`);
  }

  async init({ headless }) {
    if (this.client) return;
    this.sendToRenderer('status', `Inicializando WhatsApp (headless=${!!headless})...`);
    this.client = new Client({
      puppeteer: {
        headless: !!headless,
        args: ['--disable-dev-shm-usage']
      },
      authStrategy: new LocalAuth()
    });

    this.client.on('qr', async (qr) => {
      try {
        const dataUrl = await qrcode.toDataURL(qr);
        this.sendToRenderer('qr', dataUrl);
        this.sendToRenderer('status', 'Escanee el QR en la ventana.');
      } catch (e) {
        this.sendToRenderer('error', `Error generando QR: ${e.message}`);
      }
    });

    this.client.on('ready', () => {
      this.sendToRenderer('success', 'Cliente de WhatsApp listo.');
    });

    // Log de mensajes entrantes a la UI
    this.client.on('message', (msg) => {
      const isTarget = TARGET_NUMBERS.has(getNumberFromJid(msg.from));
      this.sendToRenderer('message', {
        direction: 'in',
        from: msg.from,
        body: msg.body || `[${msg.type}]`,
        at: new Date().toISOString(),
        targetChat: isTarget
      });
    });

    this.client.on('auth_failure', async (msg) => {
      this.sendToRenderer('error', `Fallo de autenticación: ${msg}`);
      await this.notifyAlert(`❌ Fallo de autenticación en WhatsApp-bot: ${msg}`);
    });

    this.client.on('disconnected', async (reason) => {
      this.sendToRenderer('error', `Cliente desconectado: ${reason}`);
      await this.notifyAlert(`⚠️ Cliente desconectado: ${reason}`);
    });

    await this.client.initialize();
  }

  startSchedule() {
    if (this.scheduler) return;
    const scheduleOnce = async () => {
      try {
        await this.runScenarioOnce();
      } catch (e) {
        // Frenar todo proceso ante cualquier fallo
        this.stopSchedule();
        this.sendToRenderer('error', 'Scheduler detenido por error en prueba.');
        return;
      }
      const next = nextHalfHourDate();
      const ms = next - new Date();
      this.sendToRenderer('status', `Próxima ejecución: ${next.toLocaleTimeString()}`);
      this.scheduler = setTimeout(scheduleOnce, ms);
    };
    const next = nextHalfHourDate();
    const ms = next - new Date();
    this.sendToRenderer('status', `Programado para: ${next.toLocaleTimeString()}`);
    this.scheduler = setTimeout(scheduleOnce, ms);
  }

  stopSchedule() {
    if (this.scheduler) {
      clearTimeout(this.scheduler);
      this.scheduler = null;
      this.sendToRenderer('status', 'Programación detenida');
    }
  }

  async runScenarioOnce() {
    if (!this.client) throw new Error('Cliente no inicializado');
    this.sendToRenderer('status', 'Ejecutando escenario...');
    try {
      await this._runScenario();
      this.sendToRenderer('success', 'Cotización completada exitosamente.');
    } catch (e) {
      this.sendToRenderer('error', `Error en escenario: ${e.message}`);
      await this.notifyAlert(`❌ Error en escenario: ${e.message}`);
      throw e;
    }
  }

  async waitForText(expectedText, timeout = 65000) {
    const candidates = Array.isArray(expectedText) ? expectedText : [expectedText];
    return new Promise((resolve, reject) => {
      const onMessage = msg => {
  if (!msg.body || !TARGET_NUMBERS.has(getNumberFromJid(msg.from))) return;
        for (const c of candidates) {
          if (this._includesNormalized(msg.body, c)) {
            this.client.removeListener('message', onMessage);
      // registrar chat como activo (p.ej. cambia de @lid a @c.us)
      this.activeChatIds.add(msg.from);
            resolve(msg);
            return;
          }
        }
      };
      this.client.on('message', onMessage);
      setTimeout(() => {
        this.client.removeListener('message', onMessage);
        reject(new Error(`Timeout esperando mensaje: ${Array.isArray(expectedText) ? expectedText.join(' | ') : expectedText}`));
      }, timeout);
    });
  }

  async waitForMedia(mediaType, timeout = 65000, errorMessage = null) {
    return new Promise((resolve, reject) => {
      const onMessage = msg => {
  if (TARGET_NUMBERS.has(getNumberFromJid(msg.from)) && msg.hasMedia && msg.type === mediaType) {
          this.client.removeListener('message', onMessage);
          this.activeChatIds.add(msg.from);
          resolve(msg);
        }
      };
      this.client.on('message', onMessage);
      setTimeout(() => {
        this.client.removeListener('message', onMessage);
        const errMsg = errorMessage || `Timeout esperando media: ${mediaType}`;
        reject(new Error(errMsg));
      }, timeout);
    });
  }

  async waitForMultiple(conditions, timeout = 65000) {
    for (const cond of conditions) {
      if (cond.type === 'text') {
        await this.waitForText(cond.value, timeout);
      } else if (cond.type === 'media') {
        await this.waitForMedia(cond.mediaType, timeout, cond.errorMessage);
      }
    }
  }

  async overlayDateTimePng(inputBuffer) {
    const now = new Date();
    const text = `${now.toLocaleDateString()} ${now.toLocaleTimeString()}`;
    const img = await sharp(inputBuffer).ensureAlpha();
    const meta = await img.metadata();
    const baseW = Math.max(1, meta.width || 1200);
    const baseH = Math.max(1, meta.height || 800);
    // Banda ~6% de alto, dentro de [60, 160]
    const bandH = Math.min(160, Math.max(60, Math.round(baseH * 0.06)));
    const fontSize = Math.max(28, Math.min(56, Math.round(bandH * 0.6)));
    // Overlay SVG del mismo ancho que la imagen para garantizar que no excede dimensiones
    const svg = `<svg width="${baseW}" height="${bandH}" viewBox="0 0 ${baseW} ${bandH}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${baseW}" height="${bandH}" fill="rgba(0,0,0,0.5)" />
      <text x="20" y="${Math.round(bandH * 0.72)}" font-size="${fontSize}" fill="#fff" font-family="Arial, sans-serif">${text}</text>
    </svg>`;
    const overlay = Buffer.from(svg);
    const composed = await img
      .composite([{ input: overlay, top: 0, left: 0 }])
      .png()
      .toBuffer();
    return composed;
  }

  async takeAndSaveScreenshot(label) {
    // usar la página activa del cliente WWebJS a través de puppeteer
    const pup = this.client.pupBrowser || this.client.pupPage?.browser?.();
    const page = this.client.pupPage || (this.client.pupBrowserPages ? this.client.pupBrowserPages[0] : null);
    let activePage = page;
    try {
      if (!activePage && this.client.pupBrowser) {
        const pages = await this.client.pupBrowser.pages();
        activePage = pages[0];
      }
    } catch {}
    if (!activePage) throw new Error('No se pudo obtener la página de Puppeteer para captura.');

    const rawBuffer = await activePage.screenshot({ fullPage: true });
    const withTs = await this.overlayDateTimePng(rawBuffer);
    const now = new Date();
    const fname = `screenshot_${label}_${now.getFullYear()}${(now.getMonth()+1).toString().padStart(2,'0')}${now.getDate().toString().padStart(2,'0')}_${now.toTimeString().slice(0,8).replace(/:/g,'-')}.png`;
    const outPath = path.join(this.captureDir, fname);
    fs.writeFileSync(outPath, withTs);
    this.sendToRenderer('success', `Captura guardada en: ${outPath}`);
    return outPath;
  }

  async sendAndLog(chatId, text) {
    await this.client.sendMessage(chatId, text);
    this.sendToRenderer('message', {
      direction: 'out',
      to: chatId,
      body: text,
      at: new Date().toISOString()
    });
  }

  _getRecipients() {
    const actives = Array.from(this.activeChatIds);
    return actives.length ? actives : CHAT_IDS;
  }

  async notifyAlert(text) {
    try {
      if (!this.client) return;
      await this.client.sendMessage(DEFAULT_ALERT_CHAT_ID, text);
    } catch (e) {
      this.sendToRenderer('error', `No se pudo enviar alerta: ${e.message}`);
    }
  }

  async _runScenario() {
    const SCENARIO = {
      initialMessage: 'cotizar auto',
      steps: [
        { waitForMultiple: [
            { type: 'media', mediaType: 'sticker', errorMessage: 'No ingresó Sticker Letizia' },
            { type: 'text', value: '¿Tenés la patente del auto?' }
        ], respond: 'SI' },
        { waitFor: { type: 'text', text: '¿Cuál es la patente de tu vehículo?' }, respond: 'AA877WW' },
        { waitFor: { type: 'text', text: '¿Son correctos estos datos?' }, respond: 'NO' },
        { waitFor: { type: 'text', text: 'Marca' }, respond: 'Ford' },
        { waitFor: { type: 'text', text: 'Año' }, respond: '2020' },
        { waitFor: { type: 'text', text: 'Modelo' }, respond: 'KA' },
        { waitFor: { type: 'text', text: '¿Cuál de estas versiones de vehículo es el tuyo?' }, respond: '1' },
        { waitFor: { type: 'text', text: '¿El vehículo cuenta con GNC?' }, respond: 'SI' },
        { waitFor: { type: 'text', text: '¿Cuál es el uso que le das a tu auto?' }, respond: 'SI' },
        { waitFor: { type: 'text', text: '¿Cuál es tu código postal?' }, respond: '1405' },
        { waitFor: { type: 'media', mediaType: 'image', errorMessage: 'No ingresó documentación' } },
        { delay: 5000 },
        { send: 'empezar' }
      ]
    };

    // enviar mensaje inicial a todos los chats
  for (const chatId of CHAT_IDS) {
      await this.sendAndLog(chatId, SCENARIO.initialMessage);
    }

    await new Promise(res => setTimeout(res, 3000));
    let primerPasoRealizado = false;
    let verifiedSticker = false;
    let verifiedFinalImage = false;

    for (let i = 0; i < SCENARIO.steps.length; i++) {
      const step = SCENARIO.steps[i];
  try {
        if (!primerPasoRealizado && i === 0 && step.waitForMultiple) {
          await this.waitForMedia('sticker', 120000, 'No ingresó Sticker Letizia');
          verifiedSticker = true;
          // Aceptar variantes como texto largo + versión con/ sin acento y con asteriscos
          await this.waitForText([
            '¿Tenés la patente del auto?',
            '¿Tenes la patente del auto?',
            '*¿Tenés la patente del auto?*',
            '*¿Tenes la patente del auto?*'
          ]);
          await new Promise(res => setTimeout(res, 500));
          await this.takeAndSaveScreenshot('respuesta-tenes-patente');
          for (const chatId of this._getRecipients()) {
            await this.sendAndLog(chatId, 'SI');
          }
          primerPasoRealizado = true;
          continue;
        }

        if (step.waitForMultiple) {
          await this.waitForMultiple(step.waitForMultiple, 120000);
        } else if (step.waitFor) {
          if (step.waitFor.type === 'text') {
            await this.waitForText(step.waitFor.text);
          } else if (step.waitFor.type === 'media') {
            await this.waitForMedia(step.waitFor.mediaType, 65000, step.waitFor.errorMessage || null);
            if (step.waitFor.mediaType === 'image') verifiedFinalImage = true;
          }
        }

        if (step.respond) {
          for (const chatId of this._getRecipients()) {
      await this.sendAndLog(chatId, step.respond);
          }
        }
        if (step.send) {
          for (const chatId of this._getRecipients()) {
      await this.sendAndLog(chatId, step.send);
            if (step.send === 'empezar') {
              await this.takeAndSaveScreenshot('empezar');
            }
          }
        }
        if (step.delay) {
          await new Promise(res => setTimeout(res, step.delay));
        }
      } catch (e) {
        // detener todo y notificar
        await this.notifyAlert(`❌ Error en step ${i + 1} del escenario: ${e.message}`);
        throw new Error(`Step ${i + 1} falló: ${e.message}`);
      }
    }

    if (!verifiedSticker) throw new Error('No se verificó recepción de Sticker inicial.');
    if (!verifiedFinalImage) throw new Error('No se verificó recepción de Imagen final.');
  }
}

module.exports = BotController;
