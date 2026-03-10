let transcript = [];
let currentCaption = null;
let meetingActive = false;

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
