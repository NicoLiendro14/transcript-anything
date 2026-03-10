let mediaRecorder = null;
let mediaStream = null;
let writableStream = null;
let bytesWritten = 0;
let segmentCount = 0;
let recordingStartTime = 0;
let currentFilename = "";

const TIMESLICE_MS = 3000;
const IDB_NAME = "teams-recorder";
const IDB_STORE = "handles";
const IDB_KEY = "directoryHandle";

// --- IndexedDB helpers (shared schema with popup) ---

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

async function getDirectoryHandle() {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

// --- Message handling ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== "offscreen") return false;

  if (msg.type === "offscreen-start-recording") {
    handleStartRecording(msg.streamId, msg.filename).then(result => {
      sendResponse(result);
    }).catch(err => {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (msg.type === "offscreen-stop-recording") {
    handleStopRecording().then(result => {
      sendResponse(result);
    }).catch(err => {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (msg.type === "offscreen-get-status") {
    const duration = mediaRecorder && mediaRecorder.state === "recording"
      ? Date.now() - recordingStartTime
      : 0;
    sendResponse({
      recording: !!(mediaRecorder && mediaRecorder.state === "recording"),
      bytesWritten,
      segmentCount,
      duration,
      filename: currentFilename
    });
    return true;
  }

  return false;
});

// --- Recording logic ---

async function openWritableStream(filename) {
  const dirHandle = await getDirectoryHandle();
  if (!dirHandle) {
    throw new Error("No directory handle found in IndexedDB. Choose a folder first.");
  }

  const perm = await dirHandle.requestPermission({ mode: "readwrite" });
  if (perm !== "granted") {
    throw new Error("Directory permission denied: " + perm);
  }

  const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
  return await fileHandle.createWritable();
}

async function handleStartRecording(streamId, filename) {
  currentFilename = filename;

  writableStream = await openWritableStream(filename);

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    },
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    }
  });

  mediaStream = stream;
  bytesWritten = 0;
  segmentCount = 0;
  recordingStartTime = Date.now();

  let mimeType = "video/webm;codecs=vp9,opus";
  if (!MediaRecorder.isTypeSupported(mimeType)) {
    mimeType = "video/webm;codecs=vp8,opus";
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = "video/webm";
    }
  }

  mediaRecorder = new MediaRecorder(stream, { mimeType });

  mediaRecorder.ondataavailable = async (event) => {
    if (event.data && event.data.size > 0) {
      segmentCount++;
      try {
        if (writableStream) {
          await writableStream.write(event.data);
          bytesWritten += event.data.size;
        }
      } catch (e) {
        console.error("[Offscreen] Write error:", e);
      }
    }
  };

  mediaRecorder.onstop = async () => {
    await closeWritableStream();
    chrome.runtime.sendMessage({
      type: "recording-status",
      status: "stopped",
      bytesWritten,
      segmentCount,
      duration: Date.now() - recordingStartTime,
      filename: currentFilename
    });
  };

  mediaRecorder.onerror = (event) => {
    console.error("[Offscreen] MediaRecorder error:", event.error);
    chrome.runtime.sendMessage({
      type: "recording-status",
      status: "error",
      error: event.error?.message || "Unknown error"
    });
  };

  mediaRecorder.start(TIMESLICE_MS);

  return { ok: true, mimeType };
}

async function closeWritableStream() {
  if (writableStream) {
    try { await writableStream.close(); } catch (e) {}
    writableStream = null;
  }
}

async function handleStopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }

  const finalBytes = bytesWritten;
  const finalSegments = segmentCount;
  const finalDuration = Date.now() - recordingStartTime;
  const finalFilename = currentFilename;

  mediaRecorder = null;
  recordingStartTime = 0;

  return {
    ok: true,
    bytesWritten: finalBytes,
    segmentCount: finalSegments,
    duration: finalDuration,
    filename: finalFilename
  };
}

window.addEventListener("beforeunload", () => {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
  }
  if (writableStream) {
    try { writableStream.close(); } catch (e) {}
    writableStream = null;
  }
});
