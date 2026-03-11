const SELECTORS = {
  CONTAINER: [
    "[data-tid='closed-caption-v2-window-wrapper']",
    "[data-tid='closed-captions-renderer']",
    "[data-tid='closed-caption-renderer-wrapper']",
    "[data-tid*='closed-caption']"
  ].join(", "),
  CAPTION_ITEM: ".fui-ChatMessageCompact",
  AUTHOR: '[data-tid="author"]',
  TEXT: '[data-tid="closed-caption-text"]'
};

let observer = null;
let isCapturing = false;
let debounceTimer = null;
const DEBOUNCE_MS = 150;

const processedNodes = new WeakMap();
let knownItemCount = 0;

function findCaptionContainer() {
  return document.querySelector(SELECTORS.CONTAINER);
}

function getDirectText(el) {
  let text = "";
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent;
    }
  }
  return text.trim();
}

function extractSpeakerFromAvatar(item) {
  const img = item.querySelector(".fui-Avatar__image");
  if (!img) return "";
  const src = img.getAttribute("src") || "";
  const match = src.match(/displayname=([^&]+)/);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function extractCaption(item) {
  const authorEl = item.querySelector(SELECTORS.AUTHOR);
  const textEl = item.querySelector(SELECTORS.TEXT);
  if (!textEl) return null;

  let speaker = "";
  if (authorEl) {
    speaker = getDirectText(authorEl) || (authorEl.innerText || "").trim();
  }
  if (!speaker) {
    speaker = extractSpeakerFromAvatar(item);
  }

  const text = (textEl.innerText || textEl.textContent || "").trim();
  if (!text) return null;

  return { speaker: speaker || "", text };
}

function sendMsg(msg) {
  try {
    chrome.runtime.sendMessage(msg);
  } catch (e) {}
}

function processCaptions() {
  const container = findCaptionContainer();
  if (!container) return;

  const items = container.querySelectorAll(SELECTORS.CAPTION_ITEM);
  if (items.length === 0) return;

  const now = new Date().toISOString();

  if (items.length > knownItemCount) {
    for (let i = knownItemCount; i < items.length - 1; i++) {
      const data = extractCaption(items[i]);
      if (!data) continue;
      const prev = processedNodes.get(items[i]);
      if (prev && prev.text === data.text && prev.speaker === data.speaker) continue;
      processedNodes.set(items[i], { text: data.text, speaker: data.speaker });
      sendMsg({
        type: "caption-new",
        data: { speaker: data.speaker, text: data.text, timestamp: now }
      });
    }
  }

  knownItemCount = items.length;

  const lastItem = items[items.length - 1];
  const lastData = extractCaption(lastItem);
  if (!lastData) return;

  const prev = processedNodes.get(lastItem);

  if (!prev) {
    processedNodes.set(lastItem, { text: lastData.text, speaker: lastData.speaker });
    sendMsg({
      type: "caption-new",
      data: { speaker: lastData.speaker, text: lastData.text, timestamp: now }
    });
  } else if (prev.text !== lastData.text || prev.speaker !== lastData.speaker) {
    processedNodes.set(lastItem, { text: lastData.text, speaker: lastData.speaker });
    sendMsg({
      type: "caption-update",
      data: { speaker: lastData.speaker, text: lastData.text, timestamp: now }
    });
  }
}

function debouncedProcess() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(processCaptions, DEBOUNCE_MS);
}

function startObserver() {
  const container = findCaptionContainer();
  if (!container) return false;

  if (observer) observer.disconnect();

  observer = new MutationObserver(debouncedProcess);

  observer.observe(container, {
    childList: true,
    subtree: true,
    characterData: true
  });

  isCapturing = true;
  knownItemCount = 0;
  processCaptions();
  console.log("[TeamsCaptions] Observer activo");
  return true;
}

const POLL_INTERVAL = 2000;

function pollForContainer() {
  const container = findCaptionContainer();
  if (container) {
    if (!isCapturing) {
      startObserver();
      sendMsg({ type: "status", data: "capturing" });
    }
  } else {
    if (isCapturing) {
      isCapturing = false;
      knownItemCount = 0;
      if (observer) observer.disconnect();
      sendMsg({ type: "status", data: "waiting" });
    }
  }
}

setInterval(pollForContainer, POLL_INTERVAL);
pollForContainer();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "get-status") {
    sendResponse({
      capturing: isCapturing,
      containerFound: !!findCaptionContainer()
    });
  }
});
