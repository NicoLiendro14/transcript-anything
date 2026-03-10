const transcriptEl = document.getElementById("transcript");
const statusEl = document.getElementById("status");
const lineCountEl = document.getElementById("line-count");
const speakerCountEl = document.getElementById("speaker-count");

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
