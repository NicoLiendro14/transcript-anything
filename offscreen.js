let mediaRecorder = null;
let mediaStream = null;
let recordedChunks = [];
let bytesWritten = 0;
let segmentCount = 0;
let recordingStartTime = 0;
let currentFilename = "";

const TIMESLICE_MS = 3000;

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

async function handleStartRecording(streamId, filename) {
  currentFilename = filename;
  recordedChunks = [];
  bytesWritten = 0;
  segmentCount = 0;
  recordingStartTime = Date.now();

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

  let mimeType = "video/webm;codecs=vp9,opus";
  if (!MediaRecorder.isTypeSupported(mimeType)) {
    mimeType = "video/webm;codecs=vp8,opus";
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = "video/webm";
    }
  }

  mediaRecorder = new MediaRecorder(stream, { mimeType });

  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      recordedChunks.push(event.data);
      bytesWritten += event.data.size;
      segmentCount++;
    }
  };

  mediaRecorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || mimeType });
    const blobUrl = URL.createObjectURL(blob);

    chrome.runtime.sendMessage({
      type: "recording-complete",
      blobUrl,
      filename: currentFilename,
      bytesWritten,
      segmentCount,
      duration: Date.now() - recordingStartTime
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

function handleStopRecording() {
  return new Promise((resolve) => {
    if (!mediaRecorder || mediaRecorder.state === "inactive") {
      resolve({
        ok: true,
        bytesWritten,
        segmentCount,
        duration: Date.now() - recordingStartTime,
        filename: currentFilename
      });
      return;
    }

    mediaRecorder.addEventListener("stop", () => {
      if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
      }

      resolve({
        ok: true,
        bytesWritten,
        segmentCount,
        duration: Date.now() - recordingStartTime,
        filename: currentFilename
      });
    }, { once: true });

    mediaRecorder.stop();
  });
}

window.addEventListener("beforeunload", () => {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
  }
});
