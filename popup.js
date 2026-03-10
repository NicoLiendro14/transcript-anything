const transcriptEl = document.getElementById("transcript");
const statusEl = document.getElementById("status");
const lineCountEl = document.getElementById("line-count");
const speakerCountEl = document.getElementById("speaker-count");

// --- Recording UI elements ---
const recSetup = document.getElementById("rec-setup");
const recReady = document.getElementById("rec-ready");
const recActive = document.getElementById("rec-active");
const recDone = document.getElementById("rec-done");
const recTimer = document.getElementById("rec-timer");
const recSize = document.getElementById("rec-size");
const recFolderPath = document.getElementById("rec-folder-path");
const recDoneText = document.getElementById("rec-done-text");

let recTimerInterval = null;
let recStartTime = 0;
let writableStream = null;
let currentFileHandle = null;
let currentFilename = "";

function loadTranscript() {
  chrome.runtime.sendMessage({ type: "get-transcript" }, (response) => {
    if (!response) return;
    renderTranscript(response.transcript);
    updateStatus(response.active);
  });
}

function renderTranscript(lines) {
  if (!lines || lines.length === 0) {
    transcriptEl.innerHTML = '<p class="empty">No hay captions aún. Activá Live Captions en Teams.</p>';
    lineCountEl.textContent = "0 líneas";
    speakerCountEl.textContent = "0 speakers";
    return;
  }

  const speakers = new Set(lines.map(l => l.speaker));
  lineCountEl.textContent = `${lines.length} líneas`;
  speakerCountEl.textContent = `${speakers.size} speakers`;

  transcriptEl.innerHTML = lines.map(line => {
    const time = new Date(line.timestamp).toLocaleTimeString();
    const name = line.speaker || "Participante";
    return `<div class="line">
      <span class="time">[${time}]</span>
      <span class="speaker">${escapeHtml(name)}:</span>
      <span class="text">${escapeHtml(line.text)}</span>
    </div>`;
  }).join("");

  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function updateStatus(active) {
  if (active) {
    statusEl.textContent = "Capturando...";
    statusEl.className = "status active";
  } else {
    statusEl.textContent = "Esperando captions...";
    statusEl.className = "status waiting";
  }
}

function exportAs(format) {
  chrome.runtime.sendMessage({ type: "get-transcript" }, (response) => {
    if (!response || !response.transcript.length) return;
    const lines = response.transcript;
    let content, filename, mimeType;

    if (format === "txt") {
      content = lines.map(l => {
        const t = new Date(l.timestamp).toLocaleTimeString();
        return `[${t}] ${l.speaker || "Participante"}: ${l.text}`;
      }).join("\n");
      filename = `teams-transcript-${Date.now()}.txt`;
      mimeType = "text/plain";
    }

    if (format === "md") {
      content = `# Teams Meeting Transcript\n\n`;
      content += `> ${new Date().toLocaleDateString()}\n\n`;
      let lastSpeaker = "";
      lines.forEach(l => {
        const t = new Date(l.timestamp).toLocaleTimeString();
        const name = l.speaker || "Participante";
        if (name !== lastSpeaker) {
          content += `\n**${name}** _(${t})_\n\n`;
          lastSpeaker = name;
        }
        content += `${l.text}\n`;
      });
      filename = `teams-transcript-${Date.now()}.md`;
      mimeType = "text/markdown";
    }

    if (format === "json") {
      content = JSON.stringify(lines, null, 2);
      filename = `teams-transcript-${Date.now()}.json`;
      mimeType = "application/json";
    }

    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  });
}

document.getElementById("btn-export-txt").addEventListener("click", () => exportAs("txt"));
document.getElementById("btn-export-md").addEventListener("click", () => exportAs("md"));
document.getElementById("btn-export-json").addEventListener("click", () => exportAs("json"));

document.getElementById("btn-clear").addEventListener("click", () => {
  if (confirm("¿Limpiar toda la transcripción?")) {
    chrome.runtime.sendMessage({ type: "clear-transcript" }, () => {
      loadTranscript();
    });
  }
});

loadTranscript();
setInterval(loadTranscript, 2000);

// =====================================================
// Recording logic: File System Access + IndexedDB + UI
// =====================================================

const IDB_NAME = "teams-recorder";
const IDB_STORE = "handles";
const IDB_KEY = "directoryHandle";

function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveDirectoryHandle(handle) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(handle, IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getDirectoryHandle() {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function clearDirectoryHandle() {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = String(Math.floor(totalSec / 3600)).padStart(2, "0");
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
  const s = String(totalSec % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function generateFilename() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}-${pad(now.getMinutes())}`;
  return `teams-rec-${date}_${time}.webm`;
}

function showRecPanel(panelId) {
  [recSetup, recReady, recActive, recDone].forEach(el => el.style.display = "none");
  const target = document.getElementById(panelId);
  if (target) target.style.display = "block";
}

async function initRecordingUI() {
  const status = await new Promise(resolve => {
    chrome.runtime.sendMessage({ type: "get-recording-status" }, resolve);
  });

  if (status && status.isRecording) {
    recStartTime = status.recordingStartTime;
    showRecPanel("rec-active");
    startTimerUI(status.bytesWritten);
    startChunkPoller();
    return;
  }

  const handle = await getDirectoryHandle();
  if (handle) {
    try {
      recFolderPath.textContent = handle.name;
      showRecPanel("rec-ready");
    } catch {
      showRecPanel("rec-setup");
    }
  } else {
    showRecPanel("rec-setup");
  }
}

function startTimerUI(initialBytes) {
  updateTimerDisplay();
  recSize.textContent = `${formatBytes(initialBytes || 0)} escritos`;
  recTimerInterval = setInterval(updateTimerDisplay, 1000);
}

function updateTimerDisplay() {
  const elapsed = Date.now() - recStartTime;
  recTimer.textContent = `Grabando... ${formatDuration(elapsed)}`;
}

function stopTimerUI() {
  if (recTimerInterval) {
    clearInterval(recTimerInterval);
    recTimerInterval = null;
  }
}

let chunkPollerInterval = null;

function startChunkPoller() {
  if (chunkPollerInterval) return;
  chunkPollerInterval = setInterval(pollAndWriteChunks, 2000);
}

function stopChunkPoller() {
  if (chunkPollerInterval) {
    clearInterval(chunkPollerInterval);
    chunkPollerInterval = null;
  }
}

async function pollAndWriteChunks() {
  try {
    const result = await new Promise(resolve => {
      chrome.runtime.sendMessage({ type: "get-pending-chunks" }, resolve);
    });
    if (!result || !result.chunks || result.chunks.length === 0) return;

    for (const chunkArray of result.chunks) {
      if (writableStream) {
        const buffer = new Uint8Array(chunkArray);
        await writableStream.write(buffer);
      }
    }

    recSize.textContent = `${formatBytes(result.bytesWritten)} escritos`;
  } catch (e) {
    console.error("[Popup] Error writing chunks:", e);
  }
}

async function chooseFolder() {
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    await saveDirectoryHandle(handle);
    recFolderPath.textContent = handle.name;
    showRecPanel("rec-ready");
    return handle;
  } catch (e) {
    if (e.name !== "AbortError") {
      console.error("[Popup] Folder picker error:", e);
    }
    return null;
  }
}

async function verifyAndGetHandle() {
  let handle = await getDirectoryHandle();
  if (!handle) return null;

  const perm = await handle.requestPermission({ mode: "readwrite" });
  if (perm !== "granted") {
    await clearDirectoryHandle();
    return null;
  }
  return handle;
}

async function startRecording() {
  let dirHandle = await verifyAndGetHandle();
  if (!dirHandle) {
    dirHandle = await chooseFolder();
    if (!dirHandle) return;
  }

  currentFilename = generateFilename();
  currentFileHandle = await dirHandle.getFileHandle(currentFilename, { create: true });
  writableStream = await currentFileHandle.createWritable();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    console.error("[Popup] No active tab found");
    if (writableStream) { await writableStream.close(); writableStream = null; }
    return;
  }

  chrome.runtime.sendMessage({ type: "set-recording-filename", filename: currentFilename });

  const result = await new Promise(resolve => {
    chrome.runtime.sendMessage({ type: "start-recording", tabId: tab.id }, resolve);
  });

  if (!result || !result.ok) {
    console.error("[Popup] Start recording failed:", result?.error);
    if (writableStream) { await writableStream.close(); writableStream = null; }
    alert("Error al iniciar la grabación: " + (result?.error || "desconocido"));
    return;
  }

  recStartTime = Date.now();
  showRecPanel("rec-active");
  startTimerUI(0);
  startChunkPoller();
}

async function stopRecording() {
  stopChunkPoller();

  await pollAndWriteChunks();

  const result = await new Promise(resolve => {
    chrome.runtime.sendMessage({ type: "stop-recording" }, resolve);
  });

  await new Promise(r => setTimeout(r, 500));
  await pollAndWriteChunks();

  if (writableStream) {
    try { await writableStream.close(); } catch (e) {}
    writableStream = null;
  }

  stopTimerUI();

  const totalBytes = result?.bytesWritten || 0;
  const duration = result?.duration || (Date.now() - recStartTime);

  recDoneText.textContent =
    `Grabación guardada: ${currentFilename} (${formatBytes(totalBytes)}, ${formatDuration(duration)})`;
  showRecPanel("rec-done");

  setTimeout(() => {
    showRecPanel("rec-ready");
  }, 8000);
}

// --- Recording event listeners ---

document.getElementById("btn-choose-folder").addEventListener("click", chooseFolder);
document.getElementById("btn-change-folder").addEventListener("click", async (e) => {
  e.preventDefault();
  await chooseFolder();
});
document.getElementById("btn-start-rec").addEventListener("click", startRecording);
document.getElementById("btn-stop-rec").addEventListener("click", stopRecording);

initRecordingUI();
