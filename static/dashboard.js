// ==============================================
// GLOBAL VARIABLES
// ==============================================
let currentSession = null;
let chatMessages, messageInput, sendButton;
let micBtn, confirmBtn, cancelBtn, speakToggle;
let recognition, isListening = false, finalTranscript = "";
let voiceEnabled = false;  // Start OFF (normal icon)
let currentTypingText = "";
let speechUtterance = null;
let isSpeechActive = false;

// ==============================================
// VOICE SETUP
// ==============================================
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.lang = "en-US";
  
  recognition.onresult = function(event) {
    finalTranscript = event.results[event.results.length - 1][0].transcript;
    if (messageInput) messageInput.value = finalTranscript;
  };
  
  recognition.onend = function() {
    if (isListening) recognition.start();
  };
}

// ==============================================
// DOM INITIALIZATION
// ==============================================
document.addEventListener("DOMContentLoaded", async function() {
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
  }

  if (micBtn) micBtn.addEventListener("click", startVoice);
  if (confirmBtn) confirmBtn.addEventListener("click", confirmVoice);
  if (cancelBtn) cancelBtn.addEventListener("click", cancelVoice);
  if (speakToggle) speakToggle.addEventListener("click", perfectVoiceToggle);

  await initializeChat();
  loadChatHistory();
  loadNotifications();
  
  // Speaker starts NORMAL (no glow)
  if (speakToggle) {
    speakToggle.innerText = "🔊";
    speakToggle.classList.remove("speaking", "paused");
  }
  
  console.log("✅ PERFECT VOICE CONTROL - Tap to speak!");
});

// ==============================================
// MIC FUNCTIONS
// ==============================================
function startVoice() {
  if (!recognition) return alert("Voice not supported");
  recognition.start();
  isListening = true;
  finalTranscript = "";
  micBtn.classList.add("hidden");
  confirmBtn.classList.remove("hidden");
  cancelBtn.classList.remove("hidden");
  showWave();
}

function confirmVoice() {
  recognition.stop();
  isListening = false;
  removeWave();
  confirmBtn.classList.add("hidden");
  cancelBtn.classList.add("hidden");
  micBtn.classList.remove("hidden");
  sendMessage();
}

function cancelVoice() {
  recognition.stop();
  isListening = false;
  if (messageInput) messageInput.value = "";
  removeWave();
  confirmBtn.classList.add("hidden");
  cancelBtn.classList.add("hidden");
  micBtn.classList.remove("hidden");
}

function showWave() {
  removeWave();
  const wave = document.createElement("div");
  wave.id = "wave";
  wave.className = "voice-wave";
  for (let i = 0; i < 5; i++) {
    const bar = document.createElement("div");
    bar.className = "voice-bar";
    wave.appendChild(bar);
  }
  if (messageInput?.parentNode) messageInput.parentNode.appendChild(wave);
}

function removeWave() {
  const wave = document.getElementById("wave");
  if (wave) wave.remove();
}

// ==============================================
// 🔥 PERFECT VOICE TOGGLE - YOUR EXACT FLOW
// ==============================================
function perfectVoiceToggle() {
  if (!("speechSynthesis" in window)) {
    alert("Speech not supported in this browser");
    return;
  }

  voiceEnabled = !voiceEnabled;
  
  if (voiceEnabled) {
    // 🔊 GREEN - START SPEAKING IMMEDIATELY
    speakToggle.innerText = "🔊";
    speakToggle.classList.add("speaking");
    speakToggle.classList.remove("paused");
    
    // Speak whatever text is currently available (even partial)
    if (currentTypingText && currentTypingText.length > 5) {
      startSpeech(currentTypingText);
      console.log("🔊 SPEAKING NOW:", currentTypingText.substring(0, 50));
    } else {
      // No text yet - reset
      voiceEnabled = false;
      speakToggle.classList.remove("speaking");
      console.log("⚠️ No text available to speak");
    }
    
  } else {
    // 🔇 PAUSE SPEAKING
    speakToggle.innerText = "🔇";
    speakToggle.classList.remove("speaking");
    speakToggle.classList.add("paused");
    
    pauseSpeech();
    console.log("⏸️ SPEECH PAUSED");
  }
}

function startSpeech(text) {
  window.speechSynthesis.cancel(); // Clear any previous speech
  
  speechUtterance = new SpeechSynthesisUtterance(text);
  speechUtterance.lang = "en-US";
  speechUtterance.rate = 0.9;
  speechUtterance.volume = 1.0;
  speechUtterance.pitch = 1.0;
  
  speechUtterance.onstart = () => {
    isSpeechActive = true;
    console.log("✅ SPEECH STARTED");
  };
  
  speechUtterance.onend = () => {
    isSpeechActive = false;
    speakToggle.classList.remove("speaking", "paused");
    voiceEnabled = false; // Auto-reset after finish
    console.log("✅ SPEECH COMPLETED");
  };
  
  speechUtterance.onpause = () => {
    isSpeechActive = false;
    console.log("⏸️ SPEECH PAUSED");
  };
  
  speechUtterance.onresume = () => {
    isSpeechActive = true;
    console.log("▶️ SPEECH RESUMED");
  };
  
  speechUtterance.onerror = (e) => {
    console.error("Speech error:", e.error);
    speakToggle.classList.remove("speaking", "paused");
    voiceEnabled = false;
  };
  
  window.speechSynthesis.speak(speechUtterance);
}

function pauseSpeech() {
  if (speechUtterance && window.speechSynthesis.speaking) {
    window.speechSynthesis.pause();
  }
}

function resumeSpeech() {
  if (speechUtterance && window.speechSynthesis.paused) {
    window.speechSynthesis.resume();
  }
}

// ==============================================
// PERFECT TYPEWRITER (Live text updates)
// ==============================================
function typeWriter(text) {
  currentTypingText = ""; // Reset
  
  const messageDiv = document.createElement("div");
  messageDiv.className = "message assistant";
  messageDiv.id = "typingMessage";
  messageDiv.innerHTML = `<div class="message-avatar">🤖</div><div class="message-bubble"></div>`;
  chatMessages.appendChild(messageDiv);
  
  const bubble = messageDiv.querySelector(".message-bubble");
  let i = 0;
  
  function typing() {
    if (i < text.length) {
      currentTypingText = text.slice(0, i + 1); // 🔥 LIVE TEXT FOR VOICE
      bubble.innerHTML = marked.parse(currentTypingText);
      scrollToBottom();
      i++;
      setTimeout(typing, 25);
    } else {
      currentTypingText = text; // Final text
    }
  }
  typing();
}

// ==============================================
// CHAT FUNCTIONS
// ==============================================
async function createNewChat() {
  try {
    const response = await fetch("/chat/new");
    const data = await response.json();
    currentSession = data.session_id;
    if (chatMessages) chatMessages.innerHTML = "";
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
      item.className = "chat-item" + (chat.id === currentSession ? " active" : "");
      item.innerHTML = `
        <div class="chat-avatar">💬</div>
        <div class="chat-preview">${chat.title}</div>
        <div class="chat-time">${chat.time}</div>
        <button class="delete-chat" onclick="deleteChat(${chat.id}, event)">🗑</button>
      `;
      item.onclick = (e) => {
        if (e.target.classList.contains("delete-chat")) return;
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
  try {
    const response = await fetch(`/chat/messages/${sessionId}`);
    const messages = await response.json();
    if (chatMessages) {
      chatMessages.innerHTML = "";
      messages.forEach((m) => addMessage(m.content, m.role === "user"));
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
    const response = await fetch(`/chat/delete/${chatId}`, { method: "DELETE" });
    const result = await response.json();
    if (result.success) {
      loadChatHistory();
      if (chatMessages) chatMessages.innerHTML = "";
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
  if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addMessage(text, isUser = false) {
  const messageDiv = document.createElement("div");
  messageDiv.className = `message ${isUser ? "user" : "assistant"}`;
  const formattedText = isUser ? text : marked.parse(text);
  messageDiv.innerHTML = `
    <div class="message-avatar">${isUser ? "🧑" : "🤖"}</div>
    <div class="message-bubble">${formattedText}</div>
  `;
  chatMessages.appendChild(messageDiv);
  scrollToBottom();
}

function showTypingIndicator() {
  const typingDiv = document.createElement("div");
  typingDiv.className = "message assistant";
  typingDiv.id = "typingIndicator";
  typingDiv.innerHTML = `<div class="message-avatar">🤖</div><div class="message-bubble">Typing...</div>`;
  chatMessages.appendChild(typingDiv);
  scrollToBottom();
}

function hideTypingIndicator() {
  const typingIndicator = document.getElementById("typingIndicator");
  if (typingIndicator) typingIndicator.remove();
}

async function sendMessage() {
  const message = messageInput.value.trim();
  if (!message || !currentSession) return;

  addMessage(message, true);
  messageInput.value = "";
  showTypingIndicator();

  try {
    const formData = new FormData();
    formData.append("msg", message);
    formData.append("session_id", currentSession);
    
    const response = await fetch("/get", { method: "POST", body: formData });
    hideTypingIndicator();
    
    if (response.ok) {
      const botResponse = await response.text();
      typeWriter(botResponse);
      loadChatHistory();
    } else {
      addMessage("Sorry, something went wrong.");
    }
  } catch (error) {
    console.error("Send failed:", error);
    hideTypingIndicator();
    addMessage("Connection error.");
  }
}

function sendSuggestion(text) {
  if (messageInput) messageInput.value = text;
  sendMessage();
}

// Other functions (unchanged)...
function handleLogout() {
  if (confirm("Logout?")) {
    localStorage.clear();
    sessionStorage.clear();
    window.location.href = "/logout";
  }
}

function openProfileModal() {
  const modal = document.getElementById("profileModal");
  if (modal) modal.style.display = "flex";
}

function closeProfileModal() {
  const modal = document.getElementById("profileModal");
  if (modal) modal.style.display = "none";
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

async function loadNotifications() {
  try {
    const response = await fetch("/notifications");
    const data = await response.json();
    const count = document.getElementById("notifCount");
    if (count) count.innerText = data.length;
  } catch (error) {
    console.error("Notifications failed");
  }
}

function toggleNotificationPopup() {
  const popup = document.getElementById("notificationPopup");
  if (popup) {
    popup.style.display = popup.style.display === "block" ? "none" : "block";
    if (popup.style.display === "block") loadNotificationPopup();
  }
}

async function loadNotificationPopup() {
  try {
    const response = await fetch("/notifications");
    const data = await response.json();
    const list = document.getElementById("notificationList");
    if (list) {
      list.innerHTML = data.length === 0 
        ? "<p style='text-align:center; opacity:0.6;'>No notifications</p>"
        : data.map(n => `
          <div class="notification-item" style="border-left: 4px solid ${n.type === 'upload' ? '#3b82f6' : '#10b981'}">
            <div>${n.text}</div><small>${n.time}</small>
          </div>
        `).join('');
    }
  } catch (error) {
    console.error("Popup failed");
  }
}

if (typeof io !== 'undefined') {
  const socket = io();
  socket.on("new_notification", function(data) {
    const badge = document.getElementById("notifCount");
    if (badge) badge.innerText = parseInt(badge.innerText || 0) + 1;
  });
}

// Global functions
window.createNewChat = createNewChat;
window.deleteChat = deleteChat;
window.sendSuggestion = sendSuggestion;
window.handleLogout = handleLogout;
window.openProfileModal = openProfileModal;
window.closeProfileModal = closeProfileModal;
window.requestAdminAccess = requestAdminAccess;
window.toggleNotificationPopup = toggleNotificationPopup;
