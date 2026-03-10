let mediaRecorder = null;
let mediaStream = null;
let writableStream = null;
let bytesWritten = 0;
let segmentCount = 0;
let recordingStartTime = 0;

const TIMESLICE_MS = 3000;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "start-recording") {
    handleStartRecording(msg.streamId).then(result => {
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

  if (msg.type === "get-offscreen-status") {
    const duration = mediaRecorder && mediaRecorder.state === "recording"
      ? Date.now() - recordingStartTime
      : 0;
    sendResponse({
      recording: !!(mediaRecorder && mediaRecorder.state === "recording"),
      bytesWritten,
      segmentCount,
      duration
    });
    return true;
  }
});

async function handleStartRecording(streamId) {
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
      const arrayBuffer = await event.data.arrayBuffer();
      bytesWritten += arrayBuffer.byteLength;

      chrome.runtime.sendMessage({
        type: "recording-chunk",
        chunk: Array.from(new Uint8Array(arrayBuffer)),
        segment: segmentCount,
        bytesWritten,
        duration: Date.now() - recordingStartTime
      });
    }
  };

  mediaRecorder.onstop = () => {
    chrome.runtime.sendMessage({
      type: "recording-status",
      status: "stopped",
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

  chrome.runtime.sendMessage({
    type: "recording-status",
    status: "recording",
    bytesWritten: 0,
    segmentCount: 0,
    duration: 0
  });

  return { ok: true, mimeType };
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

  mediaRecorder = null;
  recordingStartTime = 0;

  return {
    ok: true,
    bytesWritten: finalBytes,
    segmentCount: finalSegments,
    duration: finalDuration
  };
}

window.addEventListener("beforeunload", () => {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
  }
});
