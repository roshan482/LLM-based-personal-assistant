// ==============================
// GLOBAL VARIABLES
// ==============================

let chatMessages;
let messageInput;
let sendButton;
let currentSession = null;

// ==============================
// INITIALIZATION
// ==============================

document.addEventListener("DOMContentLoaded", async function () {
  chatMessages = document.getElementById("chatMessages");
  messageInput = document.getElementById("messageInput");
  sendButton = document.getElementById("sendButton");

  if (sendButton) {
    sendButton.addEventListener("click", sendMessage);
  }

  if (messageInput) {
    messageInput.addEventListener("keypress", function (e) {
      if (e.key === "Enter") {
        sendMessage();
      }
    });
  }

  await initializeChat();

  loadNotifications();
  loadRequests();
  setupUpload();
  loadDocuments(); // ✅ FIX: Load uploaded documents list on page load
  loadAnalytics();
});

// ==============================
// CHAT SYSTEM
// ==============================

async function createNewChat() {
  const response = await fetch("/chat/new");
  const data = await response.json();

  currentSession = data.session_id;

  chatMessages.innerHTML = "";

  loadChatHistory();
}

// ADD THIS FUNCTION HERE
async function initializeChat() {
  const response = await fetch("/chat/history");

  const chats = await response.json();

  if (chats.length > 0) {
    currentSession = chats[0].id;

    await loadChat(currentSession);

    loadChatHistory();
  } else {
    await createNewChat();
  }
}

async function loadChatHistory() {
  const response = await fetch("/chat/history");
  const chats = await response.json();

  const historyDiv = document.getElementById("chatHistory");

  historyDiv.innerHTML = "";

  chats.forEach((chat) => {
    const item = document.createElement("div");

    item.className = "chat-item";

    if (chat.id === currentSession) {
      item.classList.add("active");
    }

    item.innerHTML = `
      <div class="chat-avatar">💬</div>
      <div class="chat-preview">${chat.title}</div>
      <div class="chat-time">${chat.time}</div>
      <button class="delete-chat" onclick="deleteChat(${chat.id},event)">🗑</button>
    `;

    item.onclick = () => loadChat(chat.id);

    historyDiv.appendChild(item);
  });
}

async function loadChat(sessionId) {
  currentSession = sessionId;

  const response = await fetch(`/chat/messages/${sessionId}`);
  const messages = await response.json();

  chatMessages.innerHTML = "";

  messages.forEach((m) => {
    addMessage(m.content, m.role === "user");
  });

  // 🔥 FIX: Refresh sidebar to update active chat
  loadChatHistory();
}

async function deleteChat(chatId, event) {
  event.stopPropagation();

  if (!confirm("Delete this chat?")) return;

  const response = await fetch(`/chat/delete/${chatId}`, {
    method: "DELETE",
  });

  const result = await response.json();

  if (result.success) {
    loadChatHistory();

    chatMessages.innerHTML = "";
  }
}

async function sendMessage() {
  const message = messageInput.value.trim();

  if (!message) return;

  addMessage(message, true);

  messageInput.value = "";

  showTypingIndicator();

  const formData = new FormData();

  formData.append("msg", message);
  formData.append("session_id", currentSession);

  try {
    const response = await fetch("/get", {
      method: "POST",
      body: formData,
    });

    hideTypingIndicator();

    if (response.ok) {
      const botResponse = await response.text();

      typeWriter(botResponse);

      loadChatHistory();
    }
  } catch (error) {
    hideTypingIndicator();

    addMessage("Server error");
  }
}

// ==============================
// CHAT UI
// ==============================

function addMessage(text, isUser = false) {
  const messageDiv = document.createElement("div");

  messageDiv.className = `message ${isUser ? "user" : "assistant"}`;

  messageDiv.innerHTML = `
      <div class="message-avatar">
        ${isUser ? "🧑" : "🤖"}
      </div>

      <div class="message-bubble">
        ${text}
      </div>
  `;

  chatMessages.appendChild(messageDiv);

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function typeWriter(text) {
  const messageDiv = document.createElement("div");

  messageDiv.className = "message assistant";

  messageDiv.innerHTML = `
    <div class="message-avatar">🤖</div>
    <div class="message-bubble"></div>
  `;

  chatMessages.appendChild(messageDiv);

  const bubble = messageDiv.querySelector(".message-bubble");

  let i = 0;
  let currentText = "";

  function typing() {
    if (i < text.length) {
      currentText += text.charAt(i);

      bubble.innerHTML = currentText;

      i++;

      chatMessages.scrollTop = chatMessages.scrollHeight;

      setTimeout(typing, 15);
    }
  }

  typing();
}

function showTypingIndicator() {
  const typingDiv = document.createElement("div");

  typingDiv.className = "message assistant";

  typingDiv.id = "typingIndicator";

  typingDiv.innerHTML = `
    <div class="message-avatar">🤖</div>
    <div class="message-bubble">Typing...</div>
  `;

  chatMessages.appendChild(typingDiv);
}

function hideTypingIndicator() {
  const typing = document.getElementById("typingIndicator");

  if (typing) typing.remove();
}

function insertEmoji() {
  messageInput.value += "😊";

  messageInput.focus();
}

// ==============================
// SIDEBAR MENU
// ==============================

function openSection(section) {
  // 1. Hide all sections
  document.querySelectorAll(".section").forEach((s) => {
    s.classList.remove("active");
  });

  // 2. Show selected section
  const target = document.getElementById(section + "-section");
  if (target) {
    target.classList.add("active");
  }

  // 3. Remove active from all sidebar items
  document.querySelectorAll(".menu-item").forEach((item) => {
    item.classList.remove("active");
  });

  // 4. Add active to clicked sidebar item
  document.querySelectorAll(".menu-item").forEach((item) => {
    const onclickAttr = item.getAttribute("onclick");

    if (onclickAttr && onclickAttr.includes(`'${section}'`)) {
      item.classList.add("active");
    }
  });

  // ✅ LOAD PROFILE DATA ONLY WHEN OPENED
  if (section === "profile") {
    loadProfile();
  }

  if (section === "usage") {
    loadStats(); // allow DOM to render first
  }
}

// ==============================
// LOGOUT
// ==============================

function handleLogout() {
  if (confirm("Logout?")) {
    window.location.href = "/logout";
  }
}

// ==============================
// NOTIFICATIONS
// ==============================

async function loadNotifications() {
  const response = await fetch("/admin/notifications");

  const data = await response.json();

  const count = document.getElementById("notifCount");

  if (count) count.innerText = data.length;
}

function toggleNotificationPopup() {
  const popup = document.getElementById("notificationPopup");
  const count = document.getElementById("notifCount");

  const isOpen = popup.style.display === "block";

  if (isOpen) {
    popup.style.display = "none";
  } else {
    popup.style.display = "block";

    // Load notifications
    loadNotificationPopup();

    // 🔥 RESET COUNT
    if (count) {
      count.innerText = "0";
    }
  }
}

document.addEventListener("click", function (e) {
  const popup = document.getElementById("notificationPopup");
  const icon = document.querySelector(".notification-icon");

  if (!popup || !icon) return;

  if (!popup.contains(e.target) && !icon.contains(e.target)) {
    popup.style.display = "none";
  }
});

async function loadNotificationPopup() {
  const response = await fetch("/admin/notifications");

  const data = await response.json();

  const list = document.getElementById("notificationList");

  list.innerHTML = "";

  data.forEach((n) => {
    const div = document.createElement("div");

    div.className = "notification-item";

    div.innerHTML = `
      ${n.text}
      <br>
      <small>${n.time}</small>
    `;

    list.appendChild(div);
  });
}

// ==============================
// ADMIN REQUESTS
// ==============================

async function loadRequests() {
  const response = await fetch("/admin/requests");
  const requests = await response.json();

  const container = document.getElementById("requestList");

  container.innerHTML = "";

  // ✅ NO REQUEST UI
  if (requests.length === 0) {
    container.innerHTML = `
      <div class="no-requests">
        <i class="fas fa-inbox"></i>
        <h3>No Pending Requests</h3>
        <p>All admin access requests will appear here.</p>
      </div>
    `;
    return;
  }

  // ✅ SHOW REQUESTS
  requests.forEach((r) => {
    const div = document.createElement("div");

    div.className = "request-card";

    div.innerHTML = `
      <div class="request-header">
        <div class="request-avatar">👤</div>
        <div>
          <h4>${r.username}</h4>
          <p>${r.email}</p>
        </div>
      </div>

      <div class="request-actions">
        <button class="btn-approve" onclick="approveRequest(${r.id})">
          <i class="fas fa-check"></i> Approve
        </button>

        <button class="btn-reject" onclick="rejectRequest(${r.id})">
          <i class="fas fa-times"></i> Reject
        </button>
      </div>
    `;

    container.appendChild(div);
  });
}

async function approveRequest(id) {
  await fetch(`/admin/approve/${id}`, {
    method: "POST",
  });

  loadRequests();
  loadNotifications();

  alert("User approved as admin");
}

async function rejectRequest(id) {
  await fetch(`/admin/reject/${id}`, {
    method: "POST",
  });

  loadRequests();
}

// ==============================
// REALTIME NOTIFICATIONS
// ==============================

// ==============================
// FILE UPLOAD SYSTEM  (multithreaded background processing)
// ==============================

function setupUpload() {
  const uploadForm = document.getElementById("uploadForm");
  if (!uploadForm) return;
  uploadForm.addEventListener("submit", handleUpload);
}

// ── Shared state ────────────────────────────────────────────────────────
let _activeDocId = null;
let _uploadUIRefs = null;
let _pollInterval = null; // polling timer handle

const _STAGE_LABELS = {
  parsing: "📄 Parsing document…",
  chunking: "✂️  Splitting into chunks…",
  indexing: "🔗 Indexing chunks in vector DB…",
  done: "✅ Done!",
  error: "❌ Processing failed",
};

// ── Main upload handler ─────────────────────────────────────────────────
async function handleUpload(e) {
  e.preventDefault();

  const fileInput = document.getElementById("pdfFile");
  const status = document.getElementById("uploadStatus");
  const progressBar = document.getElementById("uploadProgressBar");
  const progressContainer = document.querySelector(".upload-progress");
  const progressLabel = document.getElementById("progressLabel");
  const uploadBtn = document.getElementById("uploadBtn");

  if (!fileInput.files[0]) {
    status.innerText = "⚠️ Please select a file first.";
    return;
  }

  const MAX_MB = 50;
  if (fileInput.files[0].size > MAX_MB * 1024 * 1024) {
    status.innerText = `❌ File exceeds ${MAX_MB} MB limit.`;
    return;
  }

  const formData = new FormData();
  formData.append("file", fileInput.files[0]);

  // ── Reset UI ────────────────────────────────────────────────────────
  _stopPolling();
  progressContainer.style.display = "block";
  progressBar.style.width = "5%";
  progressBar.style.background = "linear-gradient(90deg, #3b82f6, #60a5fa)";
  if (progressLabel) progressLabel.innerText = "⏫ Uploading to server…";
  status.innerText = "⏫ Uploading file to server…";
  uploadBtn.disabled = true;

  try {
    const response = await fetch("/admin/upload", {
      method: "POST",
      body: formData,
    });

    const result = await response.json();

    if (!result.success) {
      _uploadFinished(false, result.message);
      return;
    }

    // ── File accepted — background thread has started ────────────────
    progressBar.style.width = "10%";
    if (progressLabel) progressLabel.innerText = "📄 Parsing document…";
    status.innerText = "⚙️ Processing in background…";

    // Store refs BEFORE registering the doc_id so the SocketIO listener
    // never fires before _uploadUIRefs is ready (fixes the race condition)
    _uploadUIRefs = {
      status,
      progressBar,
      progressContainer,
      progressLabel,
      uploadBtn,
    };
    _activeDocId = result.doc_id; // ← assign AFTER refs are ready

    // Start polling as a reliable fallback alongside SocketIO
    _startPolling(result.doc_id);
  } catch (err) {
    _uploadFinished(false, "Server error — " + err.message);
  }
}

// ── Apply a progress payload to the UI ─────────────────────────────────
function _applyProgress(data) {
  if (!_uploadUIRefs) return;

  const { status, progressBar, progressLabel } = _uploadUIRefs;

  const pct = Math.max(0, Math.min(100, data.pct ?? 0));
  // Prefer the server-side label (already human-readable) over the local map
  const label = data.label || _STAGE_LABELS[data.stage] || data.stage;

  progressBar.style.width = pct + "%";
  if (progressLabel) progressLabel.innerText = label;

  if (data.stage === "indexing" && data.total_chunks) {
    status.innerText = `🔗 Indexing… ${data.done_chunks ?? 0} / ${data.total_chunks} chunks`;
  } else {
    status.innerText = label;
  }

  if (data.stage === "done") {
    _uploadFinished(true, data.message || "Processing complete");
  } else if (data.stage === "error") {
    _uploadFinished(false, data.message || "Processing failed");
  }
}

// ── Called exactly once when processing ends (success OR failure) ───────
function _uploadFinished(success, message) {
  _stopPolling();
  _activeDocId = null;

  if (!_uploadUIRefs) return;
  const { status, progressBar, progressContainer, progressLabel, uploadBtn } =
    _uploadUIRefs;
  _uploadUIRefs = null;

  if (success) {
    progressBar.style.width = "100%";
    progressBar.style.background = "linear-gradient(90deg,#22c55e,#4ade80)";
    if (progressLabel) progressLabel.innerText = "✅ Done!";
    status.innerText = `✅ ${message}`;
    loadDocuments();
    setTimeout(() => {
      progressContainer.style.display = "none";
      progressBar.style.width = "0%";
      progressBar.style.background = "linear-gradient(90deg,#3b82f6,#60a5fa)";
    }, 3000);
  } else {
    progressBar.style.width = "100%";
    progressBar.style.background = "#ef4444";
    if (progressLabel) progressLabel.innerText = "❌ Failed";
    status.innerText = `❌ ${message}`;
    loadDocuments();
    setTimeout(() => {
      progressContainer.style.display = "none";
      progressBar.style.width = "0%";
      progressBar.style.background = "linear-gradient(90deg,#3b82f6,#60a5fa)";
    }, 5000);
  }

  uploadBtn.disabled = false;
}

// ── Polling fallback (every 2 s) ────────────────────────────────────────
function _startPolling(docId) {
  _stopPolling(); // clear any previous interval
  _pollInterval = setInterval(async () => {
    // Stop polling if another upload took over
    if (_activeDocId !== docId) {
      _stopPolling();
      return;
    }

    try {
      const res = await fetch(`/admin/upload/status/${docId}`);
      const data = await res.json();
      if (data.success && data.progress) {
        _applyProgress(data.progress);
      }
    } catch (_) {
      /* network blip — try again next tick */
    }
  }, 2000);
}

function _stopPolling() {
  if (_pollInterval !== null) {
    clearInterval(_pollInterval);
    _pollInterval = null;
  }
}

// ── SocketIO listener for real-time updates ─────────────────────────────
// This fires instantly when the event arrives; polling acts as the backup.
socket.on("upload_progress", function (data) {
  if (data.doc_id !== _activeDocId || !_uploadUIRefs) return;
  _applyProgress(data);
});

// ==============================
// DOCUMENTS LIST
// ==============================

// ✅ FIX: Fetch and render uploaded documents from the server
async function loadDocuments() {
  const response = await fetch("/admin/documents");
  const result = await response.json();

  const container = document.getElementById("documentsList");
  if (!container) return;

  if (!result.success || result.documents.length === 0) {
    container.innerHTML =
      "<p style='color:#94a3b8'>No documents uploaded yet.</p>";
    return;
  }

  container.innerHTML = result.documents
    .map(
      (doc) => `
    <div style="display:flex;justify-content:space-between;align-items:center;
                padding:12px;border-radius:8px;background:rgba(255,255,255,0.05);
                margin-bottom:8px;border:1px solid rgba(255,255,255,0.08)">
      <div>
        <strong>📄 ${doc.filename}</strong>
        <div style="font-size:12px;color:#94a3b8;margin-top:4px">
          ${doc.uploaded_at} &nbsp;|&nbsp;
          ${(doc.file_size / 1024).toFixed(1)} KB &nbsp;|&nbsp;
          <span style="color:${
            doc.status === "completed"
              ? "#22c55e"
              : doc.status === "failed"
                ? "#ef4444"
                : "#f59e0b"
          }">
            ${doc.status === "completed" ? `✅ ${doc.chunks_count} chunks indexed` : "⏳ " + doc.status}
          </span>
        </div>
      </div>
      <button onclick="deleteDocument(${doc.id})"
              style="background:#ef4444;border:none;color:white;padding:6px 12px;
                     border-radius:6px;cursor:pointer;font-size:12px">
        🗑 Delete
      </button>
    </div>
  `,
    )
    .join("");
}

async function deleteDocument(docId) {
  if (!confirm("Delete this document from the knowledge base?")) return;

  const response = await fetch(`/admin/delete/${docId}`, { method: "DELETE" });
  const result = await response.json();

  if (result.success) {
    loadDocuments();
  } else {
    alert("Delete failed: " + result.message);
  }
}

const socket = io();

socket.on("new_notification", function (data) {
  const badge = document.getElementById("notifCount");

  if (badge) {
    badge.innerText = parseInt(badge.innerText || 0) + 1;
  }
});

const dropArea = document.querySelector(".drop-area");
const fileInput = document.getElementById("pdfFile");

if (dropArea) {
  dropArea.addEventListener("click", () => fileInput.click());
}

async function loadProfile() {
  try {
    const response = await fetch("/api/profile");
    const data = await response.json();

    document.getElementById("profileName").innerText = data.username;
    document.getElementById("profileEmail").innerText = data.email;
    document.getElementById("profileRole").innerText = data.role.toUpperCase();
    document.getElementById("profileDate").innerText = data.created_at;
  } catch (err) {
    console.error("Profile load failed", err);
  }
}

async function loadStats() {
  try {
    const res = await fetch("/api/stats");
    const data = await res.json();

    // ===== CARDS =====
    document.getElementById("totalUsers").innerText = data.total_users;
    document.getElementById("totalAdmins").innerText = data.total_admins;
    document.getElementById("totalChats").innerText = data.total_chats;
    document.getElementById("totalMessages").innerText = data.total_messages;
    document.getElementById("totalDocs").innerText = data.documents;

    // ===== PIE CHART (User vs Admin) =====
    new Chart(document.getElementById("userChart"), {
      type: "pie",
      data: {
        labels: ["Users", "Admins"],
        datasets: [
          {
            data: [data.total_users - data.total_admins, data.total_admins],
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false, // 🔥 VERY IMPORTANT
      },
    });

    // ===== CHAT TREND =====
    const chatLabels = data.chat_trend.map((d) => d[0]);
    const chatValues = data.chat_trend.map((d) => d[1]);

    new Chart(document.getElementById("chatChart"), {
      type: "line",
      data: {
        labels: chatLabels,
        datasets: [
          {
            label: "Chats",
            data: chatValues,
            fill: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false, // 🔥 VERY IMPORTANT
      },
    });

    // ===== MESSAGE TREND =====
    const msgLabels = data.message_trend.map((d) => d[0]);
    const msgValues = data.message_trend.map((d) => d[1]);

    new Chart(document.getElementById("messageChart"), {
      type: "bar",
      data: {
        labels: msgLabels,
        datasets: [
          {
            label: "Messages",
            data: msgValues,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false, // 🔥 VERY IMPORTANT
      },
    });
  } catch (err) {
    console.error("Stats error", err);
  }
}

let userChart, chatChart, messageChart;

Chart.defaults.plugins.tooltip.backgroundColor = "#020617";
Chart.defaults.plugins.tooltip.borderColor = "#3b82f6";
Chart.defaults.plugins.tooltip.borderWidth = 1;
Chart.defaults.plugins.tooltip.padding = 10;
Chart.defaults.plugins.tooltip.cornerRadius = 6;
Chart.defaults.plugins.tooltip.titleColor = "#fff";
Chart.defaults.plugins.tooltip.bodyColor = "#cbd5f5";

Chart.defaults.plugins.legend.labels.color = "#94a3b8";

async function loadAnalytics() {
  const res = await fetch("/admin/analytics");
  const data = await res.json();

  // ===== UPDATE CARDS =====
  document.getElementById("totalUsers").innerText = data.users;
  document.getElementById("totalAdmins").innerText = data.admins;
  document.getElementById("totalChats").innerText = data.chats;
  document.getElementById("totalMessages").innerText = data.messages;
  document.getElementById("totalDocs").innerText = data.documents;

  // 🔥 DESTROY OLD CHARTS (VERY IMPORTANT)
  if (userChart) userChart.destroy();
  if (chatChart) chatChart.destroy();
  if (messageChart) messageChart.destroy();

  // ===== USER RATIO =====
  userChart = new Chart(document.getElementById("userChart"), {
    type: "doughnut",
    data: {
      labels: ["Users", "Admins"],
      datasets: [
        {
          data: [data.users - data.admins, data.admins],
          backgroundColor: ["#3b82f6", "#ef4444"],
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        tooltip: {
          enabled: true,
        },
        legend: {
          position: "bottom",
        },
      },
    },
  });

  // ===== CHAT TREND =====
  chatChart = new Chart(document.getElementById("chatChart"), {
    type: "line",
    data: {
      labels: data.chat_dates,
      datasets: [
        {
          label: "Chats",
          data: data.chat_counts,
          borderColor: "#3b82f6",
          backgroundColor: "rgba(59,130,246,0.2)",
          tension: 0.4,
          fill: true,
          pointRadius: 4,
          pointHoverRadius: 6,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: "nearest",
        intersect: false,
      },
      plugins: {
        tooltip: {
          enabled: true,
          callbacks: {
            label: function (context) {
              return "Chats: " + context.raw;
            },
          },
        },
      },
    },
  });

  // ===== MESSAGE TREND =====
  messageChart = new Chart(document.getElementById("messageChart"), {
    type: "bar",
    data: {
      labels: data.msg_dates,
      datasets: [
        {
          label: "Messages",
          data: data.msg_counts,
          backgroundColor: "#6366f1",
          borderRadius: 6,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        tooltip: {
          enabled: true,
        },
      },
      scales: {
        y: {
          beginAtZero: true,
        },
      },
    },
  });

  setTimeout(() => {
    window.dispatchEvent(new Event("resize"));
  }, 200);
}
