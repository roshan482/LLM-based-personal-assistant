// ==============================
// GLOBAL VARIABLES
// ==============================

let chatMessages;
let messageInput;
let sendButton;
let currentSession = null;

let userChart, chatChart, messageChart;
let _onlinePanelVisible = true;

// ==============================
// INITIALIZATION
// ==============================

document.addEventListener("DOMContentLoaded", async function () {
  chatMessages = document.getElementById("chatMessages");
  messageInput = document.getElementById("messageInput");
  sendButton = document.getElementById("sendButton");

  if (sendButton) sendButton.addEventListener("click", sendMessage);
  if (messageInput) {
    messageInput.addEventListener("keypress", function (e) {
      if (e.key === "Enter") sendMessage();
    });
  }

  await initializeChat();
  loadNotifications();
  loadRequests();
  setupUpload();
  loadDocuments();
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
    if (chat.id === currentSession) item.classList.add("active");
    item.innerHTML = `
      <div class="chat-avatar">💬</div>
      <div class="chat-preview">${chat.title}</div>
      <div class="chat-time">${chat.time}</div>
      <button class="delete-chat" onclick="deleteChat(${chat.id},event)">🗑</button>`;
    item.onclick = () => loadChat(chat.id);
    historyDiv.appendChild(item);
  });
}

async function loadChat(sessionId) {
  currentSession = sessionId;
  const response = await fetch(`/chat/messages/${sessionId}`);
  const messages = await response.json();
  chatMessages.innerHTML = "";
  messages.forEach((m) => addMessage(m.content, m.role === "user"));
  loadChatHistory();
}

async function deleteChat(chatId, event) {
  event.stopPropagation();
  if (!confirm("Delete this chat?")) return;
  const response = await fetch(`/chat/delete/${chatId}`, { method: "DELETE" });
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
    const response = await fetch("/get", { method: "POST", body: formData });
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
    <div class="message-avatar">${isUser ? "🧑" : "🤖"}</div>
    <div class="message-bubble">${text}</div>`;
  chatMessages.appendChild(messageDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function typeWriter(text) {
  const messageDiv = document.createElement("div");
  messageDiv.className = "message assistant";
  messageDiv.innerHTML = `
    <div class="message-avatar">🤖</div>
    <div class="message-bubble"></div>`;
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
  const div = document.createElement("div");
  div.className = "message assistant";
  div.id = "typingIndicator";
  div.innerHTML = `<div class="message-avatar">🤖</div><div class="message-bubble">Typing...</div>`;
  chatMessages.appendChild(div);
}

function hideTypingIndicator() {
  const t = document.getElementById("typingIndicator");
  if (t) t.remove();
}

function insertEmoji() {
  messageInput.value += "😊";
  messageInput.focus();
}

// ==============================
// SIDEBAR MENU
// ==============================

function openSection(section) {
  document
    .querySelectorAll(".section")
    .forEach((s) => s.classList.remove("active"));
  const target = document.getElementById(section + "-section");
  if (target) target.classList.add("active");

  document.querySelectorAll(".menu-item").forEach((item) => {
    item.classList.remove("active");
    const attr = item.getAttribute("onclick");
    if (attr && attr.includes(`'${section}'`)) item.classList.add("active");
  });

  if (section === "profile") loadProfile();
  if (section === "usage") {
    loadAnalytics();
    loadOnlineUsers();
    loadDocStats();
    populateDocSelector();
  }
}

// ==============================
// LOGOUT
// ==============================

function handleLogout() {
  if (confirm("Logout?")) window.location.href = "/logout";
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
  const isOpen = popup.style.display === "block";
  popup.style.display = isOpen ? "none" : "block";
  if (!isOpen) loadNotificationPopup();
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
    div.innerHTML = `${n.text}<br><small>${n.time}</small>`;
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
  const countEl = document.getElementById("requestsCount");
  container.innerHTML = "";

  if (countEl) countEl.textContent = `${requests.length} pending`;

  if (requests.length === 0) {
    container.innerHTML = `
      <div class="no-requests">
        <h3>✅ No Pending Requests</h3>
        <p>All admin access requests will appear here.</p>
      </div>`;
    return;
  }

  requests.forEach((r) => {
    // Escape strings to safely embed in onclick attributes
    const safeName = r.username.replace(/'/g, "\\'");
    const safeEmail = r.email.replace(/'/g, "\\'");
    const safeReason = (r.reason || "")
      .replace(/'/g, "\\'")
      .replace(/\n/g, " ");
    const safeDate = (r.created_at || "").replace(/'/g, "\\'");

    const div = document.createElement("div");
    div.className = "request-card";
    div.innerHTML = `
      <div class="request-header">
        <div class="request-avatar">${r.username.charAt(0).toUpperCase()}</div>
        <div class="request-info">
          <h4>${r.username}</h4>
          <p>${r.email}</p>
          ${r.reason ? `<p class="request-meta">📝 ${r.reason}</p>` : ""}
        </div>
        <span class="${r.has_id_card ? "has-id-badge" : "no-id-badge"}">
          ${r.has_id_card ? "🪪 ID Attached" : "⚠️ No ID"}
        </span>
      </div>
      <div class="request-actions">
        <button class="btn-view"
          onclick="openVerify(${r.id},'${safeName}','${safeEmail}',${r.has_id_card},'${safeReason}','${safeDate}')">
          🔍 View & Verify
        </button>
        <button class="btn-approve" onclick="approveRequest(${r.id})">✓ Approve</button>
        <button class="btn-reject"  onclick="rejectRequest(${r.id})">✕ Reject</button>
      </div>`;
    container.appendChild(div);
  });
}

async function approveRequest(id) {
  try {
    const res = await fetch(`/admin/approve/${id}`, { method: "POST" });
    const data = await res.json();
    loadRequests();
    loadNotifications();
    _showAdminToast("✅ User approved as admin! Email sent.", "#22c55e");
  } catch (err) {
    _showAdminToast("Failed to approve. Try again.", "#ef4444");
  }
}

async function rejectRequest(id) {
  try {
    const res = await fetch(`/admin/reject/${id}`, { method: "POST" });
    const data = await res.json();
    loadRequests();
    _showAdminToast("❌ Request rejected. Email sent.", "#ef4444");
  } catch (err) {
    _showAdminToast("Failed to reject. Try again.", "#ef4444");
  }
}

// ── Shared toast helper (used by both inline buttons and the verify modal) ──
function _showAdminToast(msg, color) {
  const old = document.getElementById("_adminToast");
  if (old) old.remove();
  const t = document.createElement("div");
  t.id = "_adminToast";
  t.style.cssText = `
    position:fixed;bottom:28px;left:50%;transform:translateX(-50%);
    background:${color};color:#fff;
    padding:10px 22px;border-radius:10px;
    font-size:13px;font-weight:600;z-index:9999;
    box-shadow:0 8px 24px rgba(0,0,0,0.4);
    animation:fadeInToast 0.2s ease;font-family:inherit;
  `;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ==============================
// FILE UPLOAD SYSTEM
// ==============================

function setupUpload() {
  const uploadForm = document.getElementById("uploadForm");
  if (!uploadForm) return;
  uploadForm.addEventListener("submit", handleUpload);
}

let _activeDocId = null;
let _uploadUIRefs = null;
let _pollInterval = null;

const _STAGE_LABELS = {
  parsing: "📄 Parsing document…",
  chunking: "✂️  Splitting into chunks…",
  indexing: "🔗 Indexing chunks in vector DB…",
  done: "✅ Done!",
  error: "❌ Processing failed",
};

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

    progressBar.style.width = "10%";
    if (progressLabel) progressLabel.innerText = "📄 Parsing document…";
    status.innerText = "⚙️ Processing in background…";

    _uploadUIRefs = {
      status,
      progressBar,
      progressContainer,
      progressLabel,
      uploadBtn,
    };
    _activeDocId = result.doc_id;
    _startPolling(result.doc_id);
  } catch (err) {
    _uploadFinished(false, "Server error — " + err.message);
  }
}

function _applyProgress(data) {
  if (!_uploadUIRefs) return;
  const { status, progressBar, progressLabel } = _uploadUIRefs;
  const pct = Math.max(0, Math.min(100, data.pct ?? 0));
  const label = data.label || _STAGE_LABELS[data.stage] || data.stage;
  progressBar.style.width = pct + "%";
  if (progressLabel) progressLabel.innerText = label;
  if (data.stage === "indexing" && data.total_chunks) {
    status.innerText = `🔗 Indexing… ${data.done_chunks ?? 0} / ${data.total_chunks} chunks`;
  } else {
    status.innerText = label;
  }
  if (data.stage === "done")
    _uploadFinished(true, data.message || "Processing complete");
  else if (data.stage === "error")
    _uploadFinished(false, data.message || "Processing failed");
}

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
    // Refresh doc selector in usage section
    populateDocSelector();
    loadDocStats();
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
    setTimeout(() => {
      progressContainer.style.display = "none";
      progressBar.style.width = "0%";
      progressBar.style.background = "linear-gradient(90deg,#3b82f6,#60a5fa)";
    }, 5000);
  }
  uploadBtn.disabled = false;
}

function _startPolling(docId) {
  _stopPolling();
  _pollInterval = setInterval(async () => {
    if (_activeDocId !== docId) {
      _stopPolling();
      return;
    }
    try {
      const res = await fetch(`/admin/upload/status/${docId}`);
      const data = await res.json();
      if (data.success && data.progress) _applyProgress(data.progress);
    } catch (_) {}
  }, 2000);
}

function _stopPolling() {
  if (_pollInterval !== null) {
    clearInterval(_pollInterval);
    _pollInterval = null;
  }
}

// ==============================
// DOCUMENTS LIST
// ==============================

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
          ${doc.uploaded_at} &nbsp;|&nbsp; ${(doc.file_size / 1024).toFixed(1)} KB &nbsp;|&nbsp;
          <span style="color:${doc.status === "completed" ? "#22c55e" : doc.status === "failed" ? "#ef4444" : "#f59e0b"}">
            ${doc.status === "completed" ? `✅ ${doc.chunks_count} chunks indexed` : "⏳ " + doc.status}
          </span>
        </div>
      </div>
      <button onclick="deleteDocument(${doc.id})"
              style="background:#ef4444;border:none;color:white;padding:6px 12px;
                     border-radius:6px;cursor:pointer;font-size:12px">
        🗑 Delete
      </button>
    </div>`,
    )
    .join("");
}

async function deleteDocument(docId) {
  if (!confirm("Delete this document from the knowledge base?")) return;
  const response = await fetch(`/admin/delete/${docId}`, { method: "DELETE" });
  const result = await response.json();
  if (result.success) {
    loadDocuments();
    populateDocSelector();
    loadDocStats();
  } else {
    alert("Delete failed: " + result.message);
  }
}

// ==============================
// SOCKET.IO
// ==============================

const socket = io();

socket.on("new_notification", function (data) {
  const badge = document.getElementById("notifCount");
  if (badge) badge.innerText = parseInt(badge.innerText || 0) + 1;
});

socket.on("upload_progress", function (data) {
  if (data.doc_id !== _activeDocId || !_uploadUIRefs) return;
  _applyProgress(data);
});

// ── Real-time online users update ────────────────────────
socket.on("online_users_update", function (data) {
  _renderOnlineUsers(data.users);
});

// ── Real-time document read event ────────────────────────
socket.on("doc_read_event", function (data) {
  _addFeedItem(data);
  // If the tracked doc is open, refresh its readers
  const sel = document.getElementById("docTrackerSelect");
  if (sel && parseInt(sel.value) === data.doc_id) {
    loadDocReaders(data.doc_id);
  }
  // Refresh stats table badge counts
  _updateStatsBadge(data.doc_id);
});

// Drop area click handler
const dropArea = document.querySelector(".drop-area");
const fileInput = document.getElementById("pdfFile");
if (dropArea) dropArea.addEventListener("click", () => fileInput.click());

// ==============================
// PROFILE
// ==============================

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

// ==============================
// ANALYTICS CHARTS
// ==============================

Chart.defaults.plugins.tooltip.backgroundColor = "#020617";
Chart.defaults.plugins.tooltip.borderColor = "#3b82f6";
Chart.defaults.plugins.tooltip.borderWidth = 1;
Chart.defaults.plugins.tooltip.padding = 10;
Chart.defaults.plugins.tooltip.cornerRadius = 6;
Chart.defaults.plugins.tooltip.titleColor = "#fff";
Chart.defaults.plugins.tooltip.bodyColor = "#cbd5f5";
Chart.defaults.plugins.legend.labels.color = "#94a3b8";

async function loadAnalytics() {
  try {
    const res = await fetch("/admin/analytics");
    const data = await res.json();

    document.getElementById("totalUsers").innerText = data.users;
    document.getElementById("totalAdmins").innerText = data.admins;
    document.getElementById("totalChats").innerText = data.chats;
    document.getElementById("totalMessages").innerText = data.messages;
    document.getElementById("totalDocs").innerText = data.documents;

    if (userChart) userChart.destroy();
    if (chatChart) chatChart.destroy();
    if (messageChart) messageChart.destroy();

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
        plugins: { legend: { position: "bottom" } },
      },
    });

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
        interaction: { mode: "nearest", intersect: false },
      },
    });

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
        scales: { y: { beginAtZero: true } },
      },
    });

    setTimeout(() => window.dispatchEvent(new Event("resize")), 200);
  } catch (err) {
    console.error("Analytics error", err);
  }
}

// ==============================
// ONLINE USERS
// ==============================

async function loadOnlineUsers() {
  try {
    const res = await fetch("/admin/online-users");
    const data = await res.json();
    if (data.success) _renderOnlineUsers(data.users);
  } catch (err) {
    console.error("Online users error", err);
  }
}

function _renderOnlineUsers(users) {
  const list = document.getElementById("onlineUsersList");
  const badge = document.getElementById("onlineBadge");
  const countEl = document.getElementById("onlineCount");

  if (countEl) countEl.innerText = users.length;
  if (badge) badge.innerText = `${users.length} online`;

  if (!list) return;

  if (users.length === 0) {
    list.innerHTML = `
      <div class="tracking-empty">
        <div class="tracking-empty-icon">👥</div>
        <p>No users online</p>
      </div>`;
    return;
  }

  list.innerHTML = users
    .map(
      (u) => `
    <div class="online-user-item">
      <div class="online-user-avatar">${u.username.charAt(0).toUpperCase()}</div>
      <div class="online-user-info">
        <div class="online-user-name">${u.username}</div>
        <div class="online-user-meta">Online since ${u.since}</div>
      </div>
      <span class="online-user-role ${u.role === "admin" ? "admin" : ""}">${u.role}</span>
    </div>`,
    )
    .join("");
}

function toggleOnlinePanel() {
  _onlinePanelVisible = !_onlinePanelVisible;
  const panel = document.getElementById("onlinePanel");
  if (panel) {
    panel.style.display = _onlinePanelVisible ? "block" : "none";
  }
  if (_onlinePanelVisible) loadOnlineUsers();
}

// ==============================
// DOCUMENT READ TRACKER
// ==============================

async function populateDocSelector() {
  try {
    const res = await fetch("/admin/documents");
    const data = await res.json();
    const sel = document.getElementById("docTrackerSelect");
    if (!sel) return;

    const currentVal = sel.value;
    sel.innerHTML = `<option value="">— Select an uploaded document —</option>`;

    if (data.success) {
      data.documents
        .filter((d) => d.status === "completed")
        .forEach((d) => {
          const opt = document.createElement("option");
          opt.value = d.id;
          opt.textContent = d.filename;
          sel.appendChild(opt);
        });
    }

    // Restore previous selection
    if (currentVal) sel.value = currentVal;
  } catch (err) {
    console.error("Populate doc selector error", err);
  }
}

async function loadDocReaders(docId) {
  const readersList = document.getElementById("readersList");
  const summary = document.getElementById("docTrackerSummary");

  if (!docId) {
    readersList.innerHTML = `
      <div class="tracking-empty">
        <div class="tracking-empty-icon">📄</div>
        <p>Select a document to see who has read it</p>
      </div>`;
    if (summary) summary.style.display = "none";
    return;
  }

  readersList.innerHTML = `<div class="tracking-empty"><p>Loading…</p></div>`;

  try {
    const res = await fetch(`/admin/doc-readers/${docId}`);
    const data = await res.json();

    if (!data.success) {
      readersList.innerHTML = `<div class="tracking-empty"><p>Error loading readers.</p></div>`;
      return;
    }

    // Show summary
    if (summary) {
      summary.style.display = "flex";
      document.getElementById("summaryTotalReads").innerText = data.total_reads;
      document.getElementById("summaryUniqueUsers").innerText =
        data.readers.length;
    }

    if (data.readers.length === 0) {
      readersList.innerHTML = `
        <div class="tracking-empty">
          <div class="tracking-empty-icon">🔍</div>
          <p>No one has read this document yet</p>
        </div>`;
      return;
    }

    readersList.innerHTML = data.readers
      .map(
        (r) => `
      <div class="reader-item" onclick="openReaderModal('${r.username}', ${JSON.stringify(r.queries).replace(/"/g, "&quot;")})">
        <div class="reader-avatar">${r.username.charAt(0).toUpperCase()}</div>
        <div class="reader-info">
          <div class="reader-name">${r.username}</div>
          <div class="reader-meta">${r.email} · First read: ${r.first_read}</div>
        </div>
        <span class="reader-count">${r.query_count} quer${r.query_count === 1 ? "y" : "ies"}</span>
        <button class="view-queries-btn">View Queries</button>
      </div>`,
      )
      .join("");
  } catch (err) {
    readersList.innerHTML = `<div class="tracking-empty"><p>Failed to load readers.</p></div>`;
    console.error(err);
  }
}

function refreshDocTracker() {
  const sel = document.getElementById("docTrackerSelect");
  if (sel && sel.value) loadDocReaders(sel.value);
}

// ==============================
// DOC STATS TABLE
// ==============================

async function loadDocStats() {
  try {
    const res = await fetch("/admin/doc-stats");
    const data = await res.json();
    const tbody = document.getElementById("docStatsBody");
    if (!tbody) return;

    if (!data.success || data.stats.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="table-empty">No completed documents yet.</td></tr>`;
      return;
    }

    tbody.innerHTML = data.stats
      .map(
        (s) => `
      <tr id="stats-row-${s.id}">
        <td>
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:16px">📄</span>
            <span style="font-size:13px;font-weight:500">${s.filename}</span>
          </div>
        </td>
        <td style="color:#94a3b8;font-size:12px">${s.uploaded_at}</td>
        <td><span class="stats-badge reads" id="reads-${s.id}">${s.total_reads} reads</span></td>
        <td><span class="stats-badge users" id="users-${s.id}">${s.unique_users} users</span></td>
        <td>
          <button class="view-readers-btn" onclick="quickViewReaders(${s.id}, '${s.filename}')">
            👥 View Readers
          </button>
        </td>
      </tr>`,
      )
      .join("");
  } catch (err) {
    console.error("Doc stats error", err);
  }
}

function _updateStatsBadge(docId) {
  // Lightweight update of read count badge without full table reload
  fetch(`/admin/doc-readers/${docId}`)
    .then((r) => r.json())
    .then((data) => {
      if (!data.success) return;
      const readsEl = document.getElementById(`reads-${docId}`);
      const usersEl = document.getElementById(`users-${docId}`);
      if (readsEl) readsEl.textContent = `${data.total_reads} reads`;
      if (usersEl) usersEl.textContent = `${data.readers.length} users`;
    })
    .catch(() => {});
}

async function quickViewReaders(docId, filename) {
  // Select in doc tracker selector and load
  const sel = document.getElementById("docTrackerSelect");
  if (sel) {
    // Make sure option exists
    await populateDocSelector();
    sel.value = docId;
    loadDocReaders(docId);
    // Scroll to tracker
    document
      .getElementById("onlinePanel")
      ?.scrollIntoView({ behavior: "smooth" });
  }
}

// ==============================
// REALTIME FEED
// ==============================

function _addFeedItem(data) {
  const feed = document.getElementById("realtimeFeed");
  if (!feed) return;

  // Remove empty state
  const empty = feed.querySelector(".tracking-empty");
  if (empty) empty.remove();

  const item = document.createElement("div");
  item.className = "feed-item";
  item.innerHTML = `
    <div class="feed-dot"></div>
    <div class="feed-content">
      <div class="feed-text">
        <strong>${data.username}</strong> queried content from <strong>${data.filename}</strong>
      </div>
      <div class="feed-query">"${data.query}"</div>
    </div>
    <div class="feed-time">${data.time}</div>`;

  feed.insertBefore(item, feed.firstChild);

  // Keep max 50 items
  while (feed.children.length > 50) feed.removeChild(feed.lastChild);
}

function clearReadFeed() {
  const feed = document.getElementById("realtimeFeed");
  if (!feed) return;
  feed.innerHTML = `
    <div class="tracking-empty">
      <div class="tracking-empty-icon">📡</div>
      <p>Waiting for document queries…</p>
    </div>`;
}

// ==============================
// READER DETAIL MODAL
// ==============================

function openReaderModal(username, queries) {
  const modal = document.getElementById("readerModal");
  const title = document.getElementById("readerModalTitle");
  const body = document.getElementById("readerModalBody");

  title.innerText = `${username}'s Queries`;

  if (!queries || queries.length === 0) {
    body.innerHTML = `<p style="color:#94a3b8;text-align:center;padding:20px">No queries recorded.</p>`;
  } else {
    body.innerHTML = queries
      .map(
        (q, i) => `
      <div class="query-entry">
        <div class="query-number">${i + 1}</div>
        <div>
          <div class="query-text">${q.text}</div>
          <div class="query-time">🕐 ${q.time}</div>
        </div>
      </div>`,
      )
      .join("");
  }

  modal.classList.add("open");
}

function closeReaderModal() {
  document.getElementById("readerModal").classList.remove("open");
}
