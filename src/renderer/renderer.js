const logEl = document.getElementById('log');
const qrEl = document.getElementById('qr');
const dirLabel = document.getElementById('dirLabel');

function log(msg, cls) {
  const p = document.createElement('div');
  if (cls) p.className = cls;
  p.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.appendChild(p);
  logEl.scrollTop = logEl.scrollHeight;
}

document.getElementById('init').addEventListener('click', async () => {
  const headless = document.getElementById('headless').checked;
  await window.api.botInit({ headless });
  log('Inicializando bot...');
});

document.getElementById('selectDir').addEventListener('click', async () => {
  const dir = await window.api.selectCaptureDir();
  if (dir) {
    dirLabel.textContent = dir;
    log(`Directorio de capturas: ${dir}`);
  }
});

document.getElementById('runOnce').addEventListener('click', async () => {
  await window.api.botRunOnce();
});

document.getElementById('start').addEventListener('click', async () => {
  await window.api.botStartSchedule();
  log('Programación 30m iniciada');
});

document.getElementById('stop').addEventListener('click', async () => {
  await window.api.botStopSchedule();
  log('Programación detenida');
});

window.api.onStatus((data) => log(data));
window.api.onError((data) => log(data, 'err'));
window.api.onSuccess((data) => log(data, 'ok'));
window.api.onMessage((data) => {
  if (data.direction === 'in') {
    log(`IN <- ${data.from} ${data.targetChat ? '(objetivo)' : ''}: ${data.body}`);
  } else if (data.direction === 'out') {
    log(`OUT -> ${data.to}: ${data.body}`);
  }
});
window.api.onQr((data) => {
  // data = dataUrl PNG del QR
  const img = new Image();
  img.src = data;
  img.style.maxWidth = '100%';
  img.style.maxHeight = '100%';
  qrEl.innerHTML = '';
  qrEl.appendChild(img);
});

// ========= Últimas Capturas =========
const state = {
  lastSticker: null,
  lastImagen: null,
};

function showCapturesUI() {
  const title = document.getElementById('qrTitle');
  const qrBox = document.getElementById('qr');
  const captures = document.getElementById('captures');
  if (title) title.textContent = 'Últimas Capturas';
  if (qrBox) qrBox.style.display = 'none';
  if (captures) captures.style.display = 'block';
}

function setImgSrc(imgEl, filePath) {
  if (!imgEl || !filePath) return;
  // Preferimos file:// directo (permitido por CSP). Si falla, podríamos convertir a dataURL.
  const src = filePath.startsWith('file://') ? filePath : `file:///${filePath.replace(/\\/g, '/')}`;
  imgEl.src = src;
}

function renderCaptures() {
  const imgSticker = document.getElementById('capSticker');
  const imgImagen = document.getElementById('capImagen');
  if (state.lastSticker) setImgSrc(imgSticker, state.lastSticker);
  if (state.lastImagen) setImgSrc(imgImagen, state.lastImagen);
}

window.api.onReady(() => {
  log('WhatsApp listo. Mostrando galería de capturas.');
  showCapturesUI();
  renderCaptures();
});

window.api.onCapture(({ path, label }) => {
  log(`Nueva captura (${label}): ${path}`);
  if (label === 'sticker') state.lastSticker = path;
  if (label === 'imagen-final') state.lastImagen = path;
  renderCaptures();
});
