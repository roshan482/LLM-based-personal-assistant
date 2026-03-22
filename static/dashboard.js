// ==============================================
// GLOBAL VARIABLES
// ==============================================
let currentSession = null;
let chatMessages, messageInput, sendButton;
let micBtn, confirmBtn, cancelBtn, speakToggle;

// ── Mic / Speech Recognition ──
let recognition = null;
let isListening = false;
let micTranscript = "";

// ── TTS / Speaker ──
let ttsEnabled = false; // true = auto-speak every assistant reply
let currentUtter = null; // active SpeechSynthesisUtterance
let isSpeaking = false;

// ==============================================
// SPEECH RECOGNITION SETUP
// ==============================================
const SpeechRecognitionAPI =
  window.SpeechRecognition || window.webkitSpeechRecognition;

function initRecognition() {
  if (!SpeechRecognitionAPI) return null;

  const rec = new SpeechRecognitionAPI();
  rec.continuous = false; // single utterance — more reliable
  rec.interimResults = true; // show partial results while speaking
  rec.lang = "en-US";
  rec.maxAlternatives = 1;

  rec.onstart = () => {
    isListening = true;
    setMicUI("listening");
  };

  rec.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const t = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        micTranscript += t + " ";
      } else {
        interim = t;
      }
    }
    if (messageInput) {
      messageInput.value = (micTranscript + interim).trim();
      autoResizeTextarea();
    }
  };

  rec.onerror = (event) => {
    console.warn("Speech recognition error:", event.error);
    if (event.error === "not-allowed") {
      showToast("Microphone access denied. Please allow mic permission.");
    } else if (event.error === "no-speech") {
      showToast("No speech detected. Try again.");
    }
    stopListening();
  };

  rec.onend = () => {
    if (isListening) {
      isListening = false;
      setMicUI("idle");
    }
  };

  return rec;
}

// ==============================================
// MIC UI STATE MACHINE
// ==============================================
function setMicUI(state) {
  if (!micBtn) return;
  if (state === "listening") {
    micBtn.classList.add("mic-active");
    micBtn.title = "Click to stop";
  } else {
    micBtn.classList.remove("mic-active");
    micBtn.title = "Voice input";
  }
}

function showToast(msg) {
  const old = document.getElementById("voiceToast");
  if (old) old.remove();
  const toast = document.createElement("div");
  toast.id = "voiceToast";
  toast.textContent = msg;
  toast.style.cssText = `
    position:fixed;bottom:90px;left:50%;transform:translateX(-50%);
    background:#1e293b;color:#f8fafc;padding:10px 18px;
    border-radius:10px;font-size:13px;z-index:9999;
    border:1px solid rgba(255,255,255,0.1);
    box-shadow:0 8px 24px rgba(0,0,0,0.4);
    animation:fadeInToast 0.2s ease;font-family:inherit;
  `;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ==============================================
// MIC FUNCTIONS
// ==============================================
function toggleMic() {
  if (!SpeechRecognitionAPI) {
    showToast("Speech recognition not supported in this browser.");
    return;
  }
  if (isListening) {
    stopListening();
  } else {
    startListening();
  }
}

function startListening() {
  recognition = initRecognition();
  if (!recognition) return;
  micTranscript = "";
  if (messageInput) messageInput.value = "";
  try {
    recognition.start();
    isListening = true;
    setMicUI("listening");
    showWave();
  } catch (e) {
    console.warn("Could not start recognition:", e);
    showToast("Could not start microphone.");
    isListening = false;
    setMicUI("idle");
  }
}

function stopListening() {
  isListening = false;
  if (recognition) {
    try {
      recognition.stop();
    } catch (e) {}
  }
  setMicUI("idle");
  removeWave();
}

// Track whether mic should restart after bot reply (continuous conversation mode)
let _micContinuousMode = false;

function confirmVoice() {
  // 1. Stop recognition immediately
  stopListening();

  // 2. Reset buttons right away so UI is clean
  resetMicButtons();

  // 3. Enable continuous mode — mic will auto-restart after bot replies
  _micContinuousMode = true;

  // 4. Wait briefly for final transcript to flush, then send
  setTimeout(() => {
    if (messageInput && messageInput.value.trim()) {
      sendMessage(); // sendMessage will restart mic after reply if _micContinuousMode is true
    } else {
      _micContinuousMode = false; // nothing to send, don't continue
    }
  }, 300);
}

function cancelVoice() {
  _micContinuousMode = false; // user explicitly cancelled — stop continuous mode
  stopListening();
  if (messageInput) {
    messageInput.value = "";
    autoResizeTextarea();
  }
  resetMicButtons();
}

function resetMicButtons() {
  if (confirmBtn) confirmBtn.classList.add("hidden");
  if (cancelBtn) cancelBtn.classList.add("hidden");
  if (micBtn) micBtn.classList.remove("hidden");
  removeWave();
}

function showWave() {
  removeWave();
  const inputActions = document.querySelector(".input-actions");
  if (!inputActions) return;
  const wave = document.createElement("div");
  wave.id = "wave";
  wave.style.cssText = "display:flex;gap:3px;align-items:center;padding:0 6px;";
  for (let i = 0; i < 5; i++) {
    const bar = document.createElement("div");
    bar.className = "voice-bar";
    wave.appendChild(bar);
  }
  const sendBtn = document.getElementById("sendButton");
  inputActions.insertBefore(wave, sendBtn);
  if (micBtn) micBtn.classList.add("hidden");
  if (confirmBtn) confirmBtn.classList.remove("hidden");
  if (cancelBtn) cancelBtn.classList.remove("hidden");
}

function removeWave() {
  const wave = document.getElementById("wave");
  if (wave) wave.remove();
}

// ==============================================
// TTS — SPEAKER  (complete rewrite)
// ==============================================
/*
  BEHAVIOUR:
  • Click speaker (off)  → start speaking current chat from beginning  [state: speaking]
  • Click speaker (speaking) → STOP completely                         [state: off]
  • Click speaker (off, after stop) → restart current chat from beginning [state: speaking]
  • New bot reply while speaker is ON → speak that reply live as it types

  ttsEnabled = speaker is turned ON  (will speak new replies live)
  isSpeaking = synthesis engine is currently outputting audio
*/

let _ttsKeepAlive = null; // Chrome keepalive timer
let _liveWordBuf = ""; // buffer for live word-by-word TTS during typewriter
let _liveUtter = null; // utterance for live TTS
let _liveFlushTimer = null; // debounce timer for live TTS flushing

// ── State icon/title map ──────────────────────────────────────────────
const TTS_ICONS = {
  off: `<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`,
  speaking: `<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`,
  loading: `<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`,
};

function setSpeakerUI(state) {
  if (!speakToggle) return;
  speakToggle.classList.remove("tts-off", "tts-speaking", "tts-loading");
  speakToggle.classList.add("tts-" + state);
  speakToggle.innerHTML = TTS_ICONS[state] || TTS_ICONS.off;
  const titles = {
    off: "Read chat aloud",
    speaking: "Speaking — click to stop",
    loading: "Loading voice…",
  };
  speakToggle.title = titles[state] || "Speaker";
}

// ── Chrome keepalive (prevents 15-second cut-off bug) ────────────────
function _startKeepAlive() {
  _stopKeepAlive();
  _ttsKeepAlive = setInterval(() => {
    if (window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
      window.speechSynthesis.pause();
      window.speechSynthesis.resume();
    }
  }, 10000);
}
function _stopKeepAlive() {
  if (_ttsKeepAlive) {
    clearInterval(_ttsKeepAlive);
    _ttsKeepAlive = null;
  }
}

// ── Voice loader (async — Chrome loads voices lazily) ─────────────────
function _getVoices() {
  return new Promise((resolve) => {
    const v = window.speechSynthesis.getVoices();
    if (v.length) {
      resolve(v);
      return;
    }
    window.speechSynthesis.onvoiceschanged = () =>
      resolve(window.speechSynthesis.getVoices());
  });
}

// ── Strip markdown so it isn't read aloud ────────────────────────────
function _cleanForSpeech(text) {
  return text
    .replace(/#{1,6}\s?/g, "")
    .replace(/\*\*(.*?)\*\*/gs, "$1")
    .replace(/\*(.*?)\*/gs, "$1")
    .replace(/`{1,3}[\s\S]*?`{1,3}/g, " code block ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s*[-*+>]\s/gm, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ── Core: speak one clean string ──────────────────────────────────────
function _doSpeak(cleanText, onEnd) {
  if (!cleanText) {
    if (onEnd) onEnd();
    return;
  }

  _stopKeepAlive();
  window.speechSynthesis.cancel();

  // Chrome needs ~120 ms after cancel() before a new speak() works
  setTimeout(async () => {
    const voices = await _getVoices();
    const preferred =
      voices.find((v) => v.lang === "en-US" && v.name.includes("Google")) ||
      voices.find((v) => v.lang === "en-US" && !v.localService) ||
      voices.find(
        (v) => v.lang.startsWith("en") && v.name.includes("Natural"),
      ) ||
      voices.find(
        (v) => v.lang.startsWith("en") && v.name.includes("Samantha"),
      ) ||
      voices.find((v) => v.lang.startsWith("en"));

    const utt = new SpeechSynthesisUtterance(cleanText);
    utt.lang = "en-US";
    utt.rate = 0.93;
    utt.pitch = 1.0;
    utt.volume = 1.0;
    if (preferred) utt.voice = preferred;

    utt.onstart = () => {
      isSpeaking = true;
      setSpeakerUI("speaking");
      _startKeepAlive();
    };
    utt.onend = () => {
      isSpeaking = false;
      _stopKeepAlive();
      // Only reset UI to off if TTS was turned off during playback
      if (!ttsEnabled) setSpeakerUI("off");
      if (onEnd) onEnd();
    };
    utt.onerror = (e) => {
      if (e.error !== "interrupted" && e.error !== "canceled")
        console.warn("TTS error:", e.error);
      isSpeaking = false;
      _stopKeepAlive();
      if (!ttsEnabled) setSpeakerUI("off");
      if (onEnd) onEnd();
    };

    currentUtter = utt;
    window.speechSynthesis.speak(utt);
  }, 120);
}

// ── Get only the LATEST assistant message from the current chat DOM ──
function _getCurrentChatText() {
  const bubbles = chatMessages.querySelectorAll(
    ".message.assistant .msg-bubble",
  );
  if (!bubbles.length) return "";
  // Pick the last bubble — that is the most recent bot reply
  const last = bubbles[bubbles.length - 1];
  return _cleanForSpeech(last.innerText || last.textContent);
}

// ── Stop all TTS immediately ──────────────────────────────────────────
function _stopSpeech() {
  ttsEnabled = false;
  isSpeaking = false;
  _stopKeepAlive();
  if (_liveFlushTimer) {
    clearTimeout(_liveFlushTimer);
    _liveFlushTimer = null;
  }
  _liveWordBuf = "";
  _liveUtter = null;
  window.speechSynthesis.cancel();
  setSpeakerUI("off");
}

// ── PUBLIC: Speaker button click ──────────────────────────────────────
function toggleSpeaker() {
  if (!("speechSynthesis" in window)) {
    showToast("Text-to-speech not supported in this browser.");
    return;
  }

  if (ttsEnabled || isSpeaking) {
    // Currently ON or speaking → STOP everything
    _stopSpeech();
    return;
  }

  // Currently OFF → START reading current chat from beginning
  ttsEnabled = true;
  setSpeakerUI("loading");

  const fullText = _getCurrentChatText();
  if (!fullText) {
    showToast("No assistant messages to read yet.");
    ttsEnabled = false;
    setSpeakerUI("off");
    return;
  }

  _doSpeak(fullText, () => {
    // When finished reading the whole chat, turn off
    ttsEnabled = false;
    setSpeakerUI("off");
  });
}

// ── LIVE TTS: called from typeWriter on each new word/sentence ─────────
// We buffer words and flush every ~4 words so speech starts almost immediately
function _liveSpeakChunk(newText) {
  if (!ttsEnabled || !isSpeaking === false) {
    // Only do live TTS when speaker is actively enabled
    if (!ttsEnabled) return;
  }

  // Extract the newly added portion from newText (since last call)
  // We track a running "spoken so far" cursor in _liveWordBuf
  const newPart = newText.slice(_liveWordBuf.length);
  if (!newPart) return;

  _liveWordBuf = newText;

  // Debounce: flush every 300ms or when we hit a sentence boundary
  if (_liveFlushTimer) clearTimeout(_liveFlushTimer);

  const hasSentenceEnd = /[.!?]\s*$/.test(newPart.trim());

  if (hasSentenceEnd) {
    _flushLiveBuffer();
  } else {
    _liveFlushTimer = setTimeout(_flushLiveBuffer, 300);
  }
}

let _liveQueue = []; // queue of clean sentence chunks to speak live
let _liveBusy = false;

function _flushLiveBuffer() {
  if (!ttsEnabled) return;
  const chunk = _cleanForSpeech(_liveWordBuf)
    .replace(_cleanForSpeech(_lastSpokenChunk || ""), "")
    .trim();
  if (!chunk) return;
  _lastSpokenChunk = _liveWordBuf;
  _liveQueue.push(chunk);
  _drainLiveQueue();
}
let _lastSpokenChunk = "";

function _drainLiveQueue() {
  if (_liveBusy || _liveQueue.length === 0) return;
  _liveBusy = true;
  const chunk = _liveQueue.shift();

  const voices = window.speechSynthesis.getVoices();
  const preferred =
    voices.find((v) => v.lang === "en-US" && v.name.includes("Google")) ||
    voices.find((v) => v.lang.startsWith("en"));

  const utt = new SpeechSynthesisUtterance(chunk);
  utt.lang = "en-US";
  utt.rate = 0.93;
  utt.pitch = 1.0;
  utt.volume = 1.0;
  if (preferred) utt.voice = preferred;

  utt.onstart = () => {
    isSpeaking = true;
    setSpeakerUI("speaking");
  };
  utt.onend = () => {
    _liveBusy = false;
    _drainLiveQueue();
  };
  utt.onerror = (e) => {
    if (e.error !== "interrupted" && e.error !== "canceled")
      console.warn("Live TTS error:", e.error);
    _liveBusy = false;
    _drainLiveQueue();
  };

  currentUtter = utt;
  window.speechSynthesis.speak(utt);
}

// ── Reset live TTS state between messages ─────────────────────────────
function _resetLiveTTS() {
  _liveWordBuf = "";
  _lastSpokenChunk = "";
  _liveQueue = [];
  _liveBusy = false;
  if (_liveFlushTimer) {
    clearTimeout(_liveFlushTimer);
    _liveFlushTimer = null;
  }
}

// keep speakText as public alias (used by old code paths if any)
function speakText(text) {
  _doSpeak(_cleanForSpeech(text), null);
}

// ==============================================
// TYPEWRITER  — with live TTS
// ==============================================
function typeWriter(text, onDone) {
  hideWelcome();

  // Reset live TTS buffer for this new message
  _resetLiveTTS();

  const messageDiv = document.createElement("div");
  messageDiv.className = "message assistant";
  messageDiv.innerHTML = `
    <div class="msg-avatar bot">🤖</div>
    <div class="msg-body">
      <div class="msg-label">Assistant</div>
      <div class="msg-bubble"></div>
    </div>`;
  chatMessages.appendChild(messageDiv);

  const bubble = messageDiv.querySelector(".msg-bubble");
  let i = 0;

  function typing() {
    if (i < text.length) {
      const partial = text.slice(0, i + 1);
      bubble.innerHTML = marked.parse(partial);
      scrollToBottom();

      // Feed live TTS if speaker is ON
      if (ttsEnabled) {
        _liveSpeakChunk(partial);
      }

      i++;
      setTimeout(typing, 16);
    } else {
      // Typewriter finished — flush any remaining live buffer
      if (ttsEnabled) {
        if (_liveFlushTimer) clearTimeout(_liveFlushTimer);
        // Speak whatever wasn't spoken yet
        const remaining = _cleanForSpeech(text)
          .replace(_cleanForSpeech(_lastSpokenChunk || ""), "")
          .trim();
        if (remaining) {
          _liveQueue.push(remaining);
          _drainLiveQueue();
        }
      }

      if (typeof onDone === "function") onDone();
    }
  }
  typing();
}

// ==============================================
// AUTO-RESIZE TEXTAREA
// ==============================================
function autoResizeTextarea() {
  if (!messageInput) return;
  messageInput.style.height = "auto";
  messageInput.style.height = Math.min(messageInput.scrollHeight, 180) + "px";
}

// ==============================================
// DYNAMIC STYLES
// ==============================================
function injectDynamicStyles() {
  const style = document.createElement("style");
  style.textContent = `
    #micBtn.mic-active {
      background: rgba(239,68,68,0.15) !important;
      color: #ef4444 !important;
      animation: micPulse 1.2s infinite;
    }
    @keyframes micPulse {
      0%   { box-shadow: 0 0 0 0 rgba(239,68,68,0.5); }
      70%  { box-shadow: 0 0 0 7px rgba(239,68,68,0); }
      100% { box-shadow: 0 0 0 0 rgba(239,68,68,0); }
    }
    #speakToggle.tts-off     { color: var(--text-3) !important; background: none !important; }
    #speakToggle.tts-loading { color: #f59e0b !important; background: rgba(245,158,11,0.12) !important; animation: speakPulse 0.8s infinite; }
    #speakToggle.tts-speaking{ color: #10a37f !important; background: rgba(16,163,127,0.15) !important; animation: speakPulse 1.5s infinite; }
    @keyframes speakPulse {
      0%,100% { opacity: 1; }
      50%     { opacity: 0.55; }
    }
    @keyframes fadeInToast {
      from { opacity: 0; transform: translateX(-50%) translateY(6px); }
      to   { opacity: 1; transform: translateX(-50%) translateY(0); }
    }
    #confirmBtn { color: #10a37f !important; }
    #confirmBtn:hover { background: rgba(16,163,127,0.15) !important; }
    #cancelBtn:hover  { background: rgba(239,68,68,0.12) !important; color: #ef4444 !important; }
  `;
  document.head.appendChild(style);
}

// ==============================================
// DOM INITIALIZATION
// ==============================================
document.addEventListener("DOMContentLoaded", async function () {
  chatMessages = document.getElementById("chatMessages");
  messageInput = document.getElementById("messageInput");
  sendButton = document.getElementById("sendButton");
  micBtn = document.getElementById("micBtn");
  confirmBtn = document.getElementById("confirmBtn");
  cancelBtn = document.getElementById("cancelBtn");
  speakToggle = document.getElementById("speakToggle");

  if (sendButton) sendButton.addEventListener("click", sendMessage);

  if (messageInput) {
    messageInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    messageInput.addEventListener("input", autoResizeTextarea);
  }

  if (micBtn) micBtn.addEventListener("click", toggleMic);
  if (confirmBtn) confirmBtn.addEventListener("click", confirmVoice);
  if (cancelBtn) cancelBtn.addEventListener("click", cancelVoice);
  if (speakToggle) speakToggle.addEventListener("click", toggleSpeaker);

  // Preload TTS voices
  if ("speechSynthesis" in window) {
    window.speechSynthesis.getVoices();
    window.speechSynthesis.onvoiceschanged = () =>
      window.speechSynthesis.getVoices();
  }

  injectDynamicStyles();
  if (speakToggle) setSpeakerUI("off");

  await initializeChat();
  loadChatHistory();
  loadNotifications();
});

// ==============================================
// WELCOME SCREEN
// ==============================================
function hideWelcome() {
  const w = document.getElementById("welcomeScreen");
  if (w) w.style.display = "none";
}

function buildWelcome() {
  const w = document.createElement("div");
  w.id = "welcomeScreen";
  w.className = "welcome";
  w.innerHTML = `
    <div class="welcome-icon">🤖</div>
    <h2>What's on the agenda today?</h2>
    <p>Ask me anything — I'll search your knowledge base and give you the best answer.</p>
    <div class="suggestion-grid">
      <div class="suggestion-chip" onclick="sendSuggestion('Tell me about yourself')">Tell me about yourself</div>
      <div class="suggestion-chip" onclick="sendSuggestion('What topics can you help with?')">What topics can you help with?</div>
      <div class="suggestion-chip" onclick="sendSuggestion('Give me a quick study tip')">Give me a quick study tip</div>
      <div class="suggestion-chip" onclick="sendSuggestion('Explain RAG in simple terms')">Explain RAG in simple terms</div>
    </div>`;
  return w;
}

// ==============================================
// CHAT FUNCTIONS
// ==============================================
async function createNewChat() {
  try {
    const response = await fetch("/chat/new");
    const data = await response.json();
    currentSession = data.session_id;
    if (chatMessages) {
      chatMessages.querySelectorAll(".message").forEach((m) => m.remove());
      const w = document.getElementById("welcomeScreen");
      if (w) w.style.display = "";
      else chatMessages.appendChild(buildWelcome());
    }
    loadChatHistory();
  } catch (error) {
    console.error("Create chat failed:", error);
  }
}

async function loadChatHistory() {
  try {
    const response = await fetch("/chat/history");
    const chats = await response.json();
    const historyDiv = document.getElementById("chatHistory");
    if (!historyDiv) return;
    historyDiv.innerHTML = "";
    chats.forEach((chat) => {
      const item = document.createElement("div");
      item.className =
        "chat-item" + (chat.id === currentSession ? " active" : "");
      item.innerHTML = `
        <span class="chat-item-icon">💬</span>
        <span class="chat-preview">${chat.title}</span>
        <button class="delete-chat" onclick="deleteChat(${chat.id}, event)" title="Delete">
          <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
            <path d="M10 11v6"/><path d="M14 11v6"/>
            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
          </svg>
        </button>`;
      item.onclick = (e) => {
        if (e.target.closest(".delete-chat")) return;
        loadChat(chat.id);
      };
      historyDiv.appendChild(item);
    });
  } catch (error) {
    console.error("Load history failed:", error);
  }
}

async function loadChat(sessionId) {
  currentSession = sessionId;
  _micContinuousMode = false;
  _stopSpeech(); // stops all TTS, resets live queue, sets UI to off

  try {
    const response = await fetch(`/chat/messages/${sessionId}`);
    const messages = await response.json();
    if (chatMessages) {
      chatMessages.innerHTML = "";
      if (messages.length === 0) {
        chatMessages.appendChild(buildWelcome());
      } else {
        messages.forEach((m) => addMessage(m.content, m.role === "user"));
      }
    }
    loadChatHistory();
  } catch (error) {
    console.error("Load chat failed:", error);
  }
}

async function deleteChat(chatId, event) {
  event.stopPropagation();
  if (!confirm("Delete this chat?")) return;
  try {
    const res = await fetch(`/chat/delete/${chatId}`, { method: "DELETE" });
    const result = await res.json();
    if (result.success) {
      if (currentSession === chatId) {
        chatMessages.innerHTML = "";
        chatMessages.appendChild(buildWelcome());
      }
      loadChatHistory();
    }
  } catch (error) {
    console.error("Delete failed:", error);
  }
}

async function initializeChat() {
  try {
    const response = await fetch("/chat/history");
    const chats = await response.json();
    if (chats.length > 0) {
      currentSession = chats[0].id;
      await loadChat(currentSession);
    } else {
      await createNewChat();
    }
  } catch (error) {
    console.error("Init chat failed:", error);
    await createNewChat();
  }
}

function scrollToBottom() {
  const area = document.getElementById("chatArea");
  if (area) area.scrollTop = area.scrollHeight;
}

function addMessage(text, isUser = false) {
  hideWelcome();
  const messageDiv = document.createElement("div");
  messageDiv.className = `message ${isUser ? "user" : "assistant"}`;
  const formattedText = isUser ? text : marked.parse(text);
  const sidebarAv = document.querySelector(".user-avatar-sm");
  const initial = sidebarAv ? sidebarAv.textContent.trim() : "U";

  messageDiv.innerHTML = isUser
    ? `<div class="msg-avatar user-av">${initial.toUpperCase()}</div>
       <div class="msg-body">
         <div class="msg-bubble">${formattedText}</div>
       </div>`
    : `<div class="msg-avatar bot">🤖</div>
       <div class="msg-body">
         <div class="msg-label">Assistant</div>
         <div class="msg-bubble">${formattedText}</div>
       </div>`;
  chatMessages.appendChild(messageDiv);
  scrollToBottom();
}

function showTypingIndicator() {
  hideWelcome();
  const div = document.createElement("div");
  div.className = "message assistant";
  div.id = "typingIndicator";
  div.innerHTML = `
    <div class="msg-avatar bot">🤖</div>
    <div class="msg-body">
      <div class="msg-label">Assistant</div>
      <div class="msg-bubble">
        <div class="typing-indicator">
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
        </div>
      </div>
    </div>`;
  chatMessages.appendChild(div);
  scrollToBottom();
}

function hideTypingIndicator() {
  const t = document.getElementById("typingIndicator");
  if (t) t.remove();
}

async function sendMessage() {
  const message = messageInput.value.trim();
  if (!message || !currentSession) return;

  // Stop mic if manually recording (but NOT if confirmVoice already stopped it)
  if (isListening) stopListening();

  hideWelcome();
  addMessage(message, true);
  messageInput.value = "";
  messageInput.style.height = "auto";
  showTypingIndicator();

  try {
    const formData = new FormData();
    formData.append("msg", message);
    formData.append("session_id", currentSession);
    const response = await fetch("/get", { method: "POST", body: formData });
    hideTypingIndicator();
    if (response.ok) {
      const botResponse = await response.text();
      typeWriter(botResponse, () => {
        // Called when typewriter finishes
        // Auto-restart mic for next question if continuous mode is on
        if (_micContinuousMode) {
          setTimeout(() => startListening(), 500);
        }
      });
      loadChatHistory();
    } else {
      _micContinuousMode = false;
      addMessage("Sorry, something went wrong.");
    }
  } catch (error) {
    console.error("Send failed:", error);
    hideTypingIndicator();
    _micContinuousMode = false;
    addMessage("Connection error. Please try again.");
  }
}

function sendSuggestion(text) {
  if (messageInput) {
    messageInput.value = text;
    autoResizeTextarea();
  }
  sendMessage();
}

// ==============================================
// UI ACTIONS
// ==============================================
function handleLogout() {
  if (confirm("Sign out?")) {
    _stopKeepAlive();
    window.speechSynthesis && window.speechSynthesis.cancel();
    window.location.href = "/logout";
  }
}

function openProfileModal() {
  document.getElementById("profileModal").classList.add("open");
}
function closeProfileModal() {
  document.getElementById("profileModal").classList.remove("open");
}

async function requestAdminAccess() {
  try {
    const response = await fetch("/admin/request", { method: "POST" });
    const data = await response.json();
    const status = document.getElementById("requestStatus");
    if (status) status.innerText = data.message;
  } catch (error) {
    console.error("Admin request failed");
  }
}

// ==============================================
// NOTIFICATIONS
// ==============================================
async function loadNotifications() {
  try {
    const response = await fetch("/notifications");
    const data = await response.json();
    const badge = document.getElementById("notifCount");
    if (badge) {
      badge.innerText = data.length;
      badge.style.display = data.length > 0 ? "flex" : "none";
    }
  } catch (error) {
    console.error("Notifications failed");
  }
}

function toggleNotificationPopup() {
  const panel = document.getElementById("notificationPopup");
  const isOpen = panel.classList.contains("open");
  panel.classList.toggle("open");
  if (!isOpen) loadNotificationPopup();
}

async function loadNotificationPopup() {
  try {
    const response = await fetch("/notifications");
    const data = await response.json();
    const list = document.getElementById("notificationList");
    const countEl = document.getElementById("notifHeaderCount");
    if (!list) return;
    if (countEl) countEl.textContent = data.length;
    if (data.length === 0) {
      list.innerHTML = `<div class="notif-empty"><div class="notif-empty-icon">🔕</div><p>No notifications yet</p></div>`;
      return;
    }
    list.innerHTML = data
      .map(
        (n) => `
      <div class="notif-item">
        <div class="notif-dot ${n.type || "upload"}"></div>
        <div class="notif-content">
          <div class="notif-text">${n.text}</div>
          <div class="notif-time">${n.time}</div>
        </div>
      </div>`,
      )
      .join("");
  } catch (error) {
    console.error("Notification popup failed");
  }
}

// ==============================================
// SOCKET
// ==============================================
if (typeof io !== "undefined") {
  const socket = io();
  socket.on("new_notification", function () {
    const badge = document.getElementById("notifCount");
    if (badge) {
      badge.innerText = parseInt(badge.innerText || 0) + 1;
      badge.style.display = "flex";
    }
    const hc = document.getElementById("notifHeaderCount");
    if (hc) hc.textContent = parseInt(hc.textContent || 0) + 1;
  });
}

// ==============================================
// GLOBAL EXPORTS
// ==============================================
window.createNewChat = createNewChat;
window.deleteChat = deleteChat;
window.sendSuggestion = sendSuggestion;
window.handleLogout = handleLogout;
window.openProfileModal = openProfileModal;
window.closeProfileModal = closeProfileModal;
window.requestAdminAccess = requestAdminAccess;
window.toggleNotificationPopup = toggleNotificationPopup;
window.loadNotificationPopup = loadNotificationPopup;
