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
const OPEN_CHAT_TITLE = process.env.OPEN_CHAT_TITLE || 'La Caja';
const ZOOM_PERCENT = parseFloat(process.env.ZOOM_PERCENT || '0.8');

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
  this.lastMessageFrom = null; // último JID emisor objetivo
  this.lastChatTitle = null; // nombre visible del chat (si está disponible)
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

    this.client.on('ready', async () => {
      this.sendToRenderer('success', 'Cliente de WhatsApp listo.');
      this.sendToRenderer('whatsapp-ready', true);
      // Aplicar zoom a la página para mejores capturas/encuadre
      try { await this._applyZoomToPage(ZOOM_PERCENT); } catch (_) {}
    });

    // Log de mensajes entrantes a la UI
    this.client.on('message', async (msg) => {
      const isTarget = TARGET_NUMBERS.has(getNumberFromJid(msg.from));
      if (isTarget) {
        this.lastMessageFrom = msg.from;
        this.activeChatIds.add(msg.from);
        try {
          const chat = await msg.getChat();
          // nombre del chat para búsqueda por UI si hiciera falta
          this.lastChatTitle = chat?.name || getNumberFromJid(msg.from);
        } catch (_) {
          this.lastChatTitle = getNumberFromJid(msg.from);
        }
      }
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

  _jidVariants(jid) {
    const num = getNumberFromJid(jid || '');
    return [`${num}@c.us`, `${num}@lid`];
  }

  // Mes en español con mayúscula inicial (Enero, Febrero, ...)
  _spanishMonthName(date) {
    const months = [
      'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
      'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
    ];
    return months[date.getMonth()];
  }

  // Devuelve "Turno Mañana", "Turno Tarde" o "Turno Noche" según día y hora
  _turnoFolder(date) {
    const day = date.getDay(); // 0=Domingo, 6=Sábado
    const isWeekend = (day === 0 || day === 6);
    const h = date.getHours();
    const m = date.getMinutes();
    const minutes = h * 60 + m;
    if (isWeekend) {
      // Sábados y domingos
      if (minutes < 8 * 60) return 'Turno Noche';          // 00:00 - 07:59
      if (minutes < 16 * 60) return 'Turno Mañana';        // 08:00 - 15:59
      return 'Turno Tarde';                                // 16:00 - 23:59
    } else {
      // Lunes a viernes
      if (minutes < 9 * 60) return 'Turno Noche';          // 00:00 - 08:59
      if (minutes < 18 * 60) return 'Turno Mañana';        // 09:00 - 17:59
      return 'Turno Tarde';                                // 18:00 - 23:59
    }
  }

  // HH:MM con padding; en Windows se reemplaza ':' por '-' para nombre de archivo válido
  _timeForFilename(date) {
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const raw = `${hh}:${mm}`;
    // Evitar ':' en Windows
    return process.platform === 'win32' ? raw.replace(/:/g, '-') : raw;
  }

  async ensureChatOpen(jid) {
    if (!jid) return false;
    const variants = this._jidVariants(jid);
    for (const v of variants) {
      try {
        const chat = await this.client.getChatById(v);
        if (chat) {
          // Si existe chat.open(), úsalo primero
          if (typeof chat.open === 'function') {
            try { await chat.open(); } catch (_) {}
          }
          // Asegurar actividad
          if (typeof chat.sendSeen === 'function') {
            await chat.sendSeen();
          }
          await new Promise(r => setTimeout(r, 500));
      // No devolvemos aún: también forzamos apertura por UI para garantizar el pane derecho
      break;
        }
      } catch (_) { /* ignore and try next */ }
    }
    // Forzar apertura por UI (robusto para headless y asegura el foco de conversación)
    return this.forceOpenChatUI({ jid });
  }

  // Usa el buscador de la columna izquierda para abrir un chat por número o nombre
  async openChatViaUiSearch(page, text) {
    if (!text || !page) return false;
    // Buscar el cuadro de búsqueda en la columna izquierda (contenteditable)
    const boxes = await page.$$('div[role="textbox"][contenteditable="true"]');
    let target = null;
    let minX = Number.POSITIVE_INFINITY;
    for (const el of boxes) {
      const box = await el.boundingBox();
      if (box && box.x < minX) {
        minX = box.x;
        target = el;
      }
    }
    if (!target && boxes.length) target = boxes[0];
    if (!target) return false;
    await target.click({ clickCount: 3 }); // enfocar y seleccionar
    // Limpiar y escribir
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.type(String(text));
    // Esperar a que aparezca el primer resultado y presionar Enter
    await page.waitForTimeout(400);
    await page.keyboard.press('Enter');
    return true;
  }

  // Busca directamente en la lista y hace click por coincidencia de texto/título
  async openChatByListTitle(page, title) {
    if (!page || !title) return false;
    const ok = await page.evaluate((needle) => {
      const txt = String(needle).toLowerCase();
      const candidates = Array.from(document.querySelectorAll('[role="grid"] [role="row"], [data-testid="cell-frame-container"], [role="listitem"]'));
      function findClickable(el) {
        return el.closest('[role="row"]') || el.closest('[role="listitem"]') || el;
      }
      for (const row of candidates) {
        const content = (row.innerText || row.textContent || '').toLowerCase();
        const titleAttr = (row.getAttribute && (row.getAttribute('title') || '')) || '';
        if (content.includes(txt) || titleAttr.toLowerCase().includes(txt)) {
          const clickEl = findClickable(row);
          clickEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          clickEl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          clickEl.click();
          return true;
        }
      }
      return false;
    }, title);
    return !!ok;
  }

  // Intenta varias estrategias para abrir el chat en la UI
  async forceOpenChatUI({ jid, title } = {}) {
    try {
      const page = this.client.pupPage || (this.client.pupBrowser ? (await this.client.pupBrowser.pages())[0] : null);
      if (!page) return false;
      // Esperar a que cargue la columna izquierda
      try { await page.waitForSelector('[role="grid"], [data-testid="chat-list"]', { timeout: 5000 }); } catch {}
      const searchKey = getNumberFromJid(jid || '') || title || this.lastChatTitle || OPEN_CHAT_TITLE;
      // Desactivar zoom temporalmente para evitar offsets de click
      const shouldRestoreZoom = ZOOM_PERCENT && ZOOM_PERCENT !== 1;
      if (shouldRestoreZoom) { try { await this._setZoomOnPage(page, 1); } catch {} }
      // 1) Probamos con el buscador
      await this.openChatViaUiSearch(page, searchKey);
      await page.waitForTimeout(500);
      // 2) Si no abrió, probamos clic directo por título en la lista
      await this.openChatByListTitle(page, searchKey);
      await page.waitForTimeout(500);
      if (shouldRestoreZoom) { try { await this._setZoomOnPage(page, ZOOM_PERCENT); } catch {} }
      return true;
    } catch (_) {
      return false;
    }
  }

  // Aplica zoom a la página actual de WhatsApp Web (por ejemplo, 0.8 = 80%)
  async _applyZoomToPage(factor = 0.8) {
    try {
      const page = this.client.pupPage || (this.client.pupBrowser ? (await this.client.pupBrowser.pages())[0] : null);
      if (!page) return false;
      const f = Math.max(0.3, Math.min(2, Number(factor) || 0.8));
      await this._setZoomOnPage(page, f);
      // Intento 2 (opcional): usar atajos de zoom del navegador (puede no funcionar en headless)
      try {
        await page.keyboard.down('Control');
        if (f < 1) {
          for (let i = 0; i < Math.round((1 - f) * 5); i++) await page.keyboard.press('-');
        } else if (f > 1) {
          for (let i = 0; i < Math.round((f - 1) * 5); i++) await page.keyboard.press('=');
        }
        await page.keyboard.up('Control');
      } catch { /* ignore */ }
      return true;
    } catch {
      return false;
    }
  }

  async _setZoomOnPage(page, factor) {
    const f = Math.max(0.3, Math.min(2, Number(factor) || 1));
    await page.evaluate((ff) => {
      let st = document.getElementById('cp-zoom-style');
      if (!st) {
        st = document.createElement('style');
        st.id = 'cp-zoom-style';
        document.documentElement.appendChild(st);
      }
      st.textContent = `html{zoom:${ff}}`;
    }, f);
  }

  async takeAndSaveScreenshot(label, opts = {}) {
    const { chatJidToOpen } = opts;
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

    // Asegurar que el chat relevante esté abierto (especialmente en headless)
    const targetToOpen = chatJidToOpen || this.lastMessageFrom || this._getRecipients()[0];
    try {
      await this.ensureChatOpen(targetToOpen);
      // Garantizar apertura visual
      await this.forceOpenChatUI({ jid: targetToOpen });
    } catch {}

    const rawBuffer = await activePage.screenshot({ fullPage: true });
    const withTs = await this.overlayDateTimePng(rawBuffer);
    const now = new Date();
    // Estructura: Mes/dia-mes-año/Turno (Mañana/Tarde/Noche)/
    const monthFolder = this._spanishMonthName(now);
    const dateFolder = `${String(now.getDate()).padStart(2, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${now.getFullYear()}`;
    const turnoFolder = this._turnoFolder(now);
    const targetDir = path.join(this.captureDir, monthFolder, dateFolder, turnoFolder);
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    // Nombre: Sticker -> letizia-sticker-HH:MM.png ; Imagen -> letizia-doc-HH:MM.png
    const isSticker = (label || '').toLowerCase().includes('sticker');
    const baseName = isSticker ? 'letizia-sticker' : 'letizia-doc';
    const timePart = this._timeForFilename(now);
    const fileName = `${baseName}-${timePart}.png`;
    const outPath = path.join(targetDir, fileName);
    fs.writeFileSync(outPath, withTs);
    // Nota informativa si en Windows se sustituyó ':'
    if (process.platform === 'win32' && timePart.includes('-')) {
      this.sendToRenderer('status', 'En Windows se reemplaza ":" por "-" en el nombre del archivo.');
    }
    this.sendToRenderer('success', `Captura guardada en: ${outPath}`);
    this.sendToRenderer('capture', { path: outPath, label });
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

  // Abrir el chat principal en la UI antes de empezar (importante en headless)
  try { await this.forceOpenChatUI({ jid: CHAT_IDS[0], title: OPEN_CHAT_TITLE }); } catch {}

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
          await this.takeAndSaveScreenshot('sticker', { chatJidToOpen: this._getRecipients()[0] });
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
            if (step.waitFor.mediaType === 'image') {
              verifiedFinalImage = true;
              await new Promise(res => setTimeout(res, 400));
              await this.takeAndSaveScreenshot('imagen-final', { chatJidToOpen: this._getRecipients()[0] });
            }
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
