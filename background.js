let transcript = [];
let currentCaption = null;
let meetingActive = false;

// --- Recording state ---
let isRecording = false;
let recordingStartTime = 0;
let recordingBytesWritten = 0;
let recordingSegments = 0;
let recordingFilename = "";
let pendingChunks = [];
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
    handleStartRecording(msg.tabId).then(result => {
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
    const duration = isRecording ? Date.now() - recordingStartTime : 0;
    sendResponse({
      isRecording,
      recordingStartTime,
      bytesWritten: recordingBytesWritten,
      segments: recordingSegments,
      duration,
      filename: recordingFilename
    });
    return true;
  }

  if (msg.type === "recording-chunk") {
    recordingBytesWritten = msg.bytesWritten || recordingBytesWritten;
    recordingSegments = msg.segment || recordingSegments;
    pendingChunks.push(msg.chunk);
    return false;
  }

  if (msg.type === "get-pending-chunks") {
    const chunks = pendingChunks.splice(0);
    sendResponse({ chunks, bytesWritten: recordingBytesWritten, segments: recordingSegments });
    return true;
  }

  if (msg.type === "recording-status") {
    if (msg.status === "stopped" || msg.status === "error") {
      isRecording = false;
      recordingBytesWritten = msg.bytesWritten || recordingBytesWritten;
      recordingSegments = msg.segmentCount || recordingSegments;
    }
    if (msg.status === "recording") {
      isRecording = true;
    }
    return false;
  }

  if (msg.type === "set-recording-filename") {
    recordingFilename = msg.filename;
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

async function handleStartRecording(tabId) {
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

  const result = await chrome.runtime.sendMessage({
    type: "start-recording",
    streamId
  });

  if (result && result.ok) {
    isRecording = true;
    recordingStartTime = Date.now();
    recordingBytesWritten = 0;
    recordingSegments = 0;
    pendingChunks = [];
  }

  return result;
}

async function handleStopRecording() {
  const result = await chrome.runtime.sendMessage({
    type: "stop-recording"
  });

  isRecording = false;

  if (offscreenCreated) {
    try {
      await chrome.offscreen.closeDocument();
    } catch (e) {}
    offscreenCreated = false;
  }

  return {
    ok: true,
    bytesWritten: recordingBytesWritten,
    segments: recordingSegments,
    duration: Date.now() - recordingStartTime,
    filename: recordingFilename
  };
}

chrome.runtime.onSuspend.addListener(() => {
  if (isRecording) {
    chrome.runtime.sendMessage({ type: "stop-recording" });
  }
});
