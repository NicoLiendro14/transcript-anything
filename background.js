let transcript = [];
let currentCaption = null;
let meetingActive = false;

// --- Recording state ---
let isRecording = false;
let recordingStartTime = 0;
let recordingBytesWritten = 0;
let recordingSegments = 0;
let recordingFilename = "";
let offscreenCreated = false;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "caption-new") {
    if (currentCaption) {
      transcript.push({ ...currentCaption });
    }
    currentCaption = {
      speaker: msg.data.speaker,
      text: msg.data.text,
      timestamp: msg.data.timestamp
    };
    meetingActive = true;
    saveTranscript();
    updateBadge();
    return false;
  }

  if (msg.type === "caption-update") {
    if (currentCaption) {
      currentCaption.text = msg.data.text;
      currentCaption.timestamp = msg.data.timestamp;
      if (msg.data.speaker && (!currentCaption.speaker || currentCaption.speaker === "")) {
        currentCaption.speaker = msg.data.speaker;
      }
    }
    saveTranscript();
    return false;
  }

  if (msg.type === "status") {
    meetingActive = msg.data === "capturing";
    return false;
  }

  if (msg.type === "get-transcript") {
    sendResponse({ transcript: getFullTranscript(), active: meetingActive });
    return true;
  }

  if (msg.type === "clear-transcript") {
    transcript = [];
    currentCaption = null;
    chrome.storage.local.remove(["transcript", "lastUpdated"]);
    updateBadge();
    sendResponse({ ok: true });
    return true;
  }

  // --- Recording handlers ---

  if (msg.type === "start-recording") {
    handleStartRecording(msg.tabId, msg.filename).then(result => {
      sendResponse(result);
    }).catch(err => {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (msg.type === "stop-recording") {
    handleStopRecording().then(result => {
      sendResponse(result);
    }).catch(err => {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (msg.type === "get-recording-status") {
    fetchOffscreenStatus().then(status => {
      sendResponse(status);
    }).catch(() => {
      sendResponse({
        isRecording,
        recordingStartTime,
        bytesWritten: recordingBytesWritten,
        segments: recordingSegments,
        duration: isRecording ? Date.now() - recordingStartTime : 0,
        filename: recordingFilename
      });
    });
    return true;
  }

  if (msg.type === "recording-complete") {
    isRecording = false;
    recordingBytesWritten = msg.bytesWritten || recordingBytesWritten;
    recordingSegments = msg.segmentCount || recordingSegments;

    chrome.downloads.download({
      url: msg.blobUrl,
      filename: msg.filename || recordingFilename,
      saveAs: false
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error("[BG] Download error:", chrome.runtime.lastError.message);
      }
    });

    closeOffscreen();
    return false;
  }

  if (msg.type === "recording-status") {
    if (msg.status === "error") {
      isRecording = false;
    }
    return false;
  }
});

function getFullTranscript() {
  return currentCaption
    ? [...transcript, currentCaption]
    : [...transcript];
}

function saveTranscript() {
  chrome.storage.local.set({
    transcript: getFullTranscript(),
    lastUpdated: new Date().toISOString()
  });
}

function updateBadge() {
  const count = getFullTranscript().length;
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#4a56a8" });
}

chrome.storage.local.get(["transcript"], (result) => {
  if (result.transcript && result.transcript.length > 0) {
    transcript = result.transcript;
    updateBadge();
  }
});

// --- Recording functions ---

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"]
  });
  if (contexts.length > 0) {
    offscreenCreated = true;
    return;
  }
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Recording tab audio/video"
  });
  offscreenCreated = true;
}

async function sendToOffscreen(message) {
  return chrome.runtime.sendMessage({ ...message, target: "offscreen" });
}

async function closeOffscreen() {
  if (offscreenCreated) {
    try { await chrome.offscreen.closeDocument(); } catch (e) {}
    offscreenCreated = false;
  }
}

async function handleStartRecording(tabId, filename) {
  const streamId = await new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(id);
      }
    });
  });

  await ensureOffscreenDocument();

  const result = await sendToOffscreen({
    type: "offscreen-start-recording",
    streamId,
    filename
  });

  if (result && result.ok) {
    isRecording = true;
    recordingStartTime = Date.now();
    recordingBytesWritten = 0;
    recordingSegments = 0;
    recordingFilename = filename;
  }

  return result;
}

async function handleStopRecording() {
  let result = { ok: true };
  try {
    result = await sendToOffscreen({ type: "offscreen-stop-recording" });
  } catch (e) {}

  isRecording = false;

  return {
    ok: true,
    bytesWritten: result?.bytesWritten || recordingBytesWritten,
    segments: result?.segmentCount || recordingSegments,
    duration: result?.duration || (Date.now() - recordingStartTime),
    filename: result?.filename || recordingFilename
  };
}

async function fetchOffscreenStatus() {
  if (!offscreenCreated) {
    return {
      isRecording: false,
      recordingStartTime: 0,
      bytesWritten: 0,
      segments: 0,
      duration: 0,
      filename: ""
    };
  }
  const s = await sendToOffscreen({ type: "offscreen-get-status" });
  isRecording = s.recording;
  recordingBytesWritten = s.bytesWritten;
  recordingSegments = s.segmentCount;
  return {
    isRecording: s.recording,
    recordingStartTime,
    bytesWritten: s.bytesWritten,
    segments: s.segmentCount,
    duration: s.duration,
    filename: s.filename || recordingFilename
  };
}

chrome.runtime.onSuspend.addListener(() => {
  if (isRecording) {
    sendToOffscreen({ type: "offscreen-stop-recording" });
  }
});
