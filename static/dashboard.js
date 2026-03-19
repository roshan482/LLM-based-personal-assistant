let currentSession = null;

async function createNewChat() {
  const response = await fetch("/chat/new");
  const data = await response.json();

  currentSession = data.session_id;

  chatMessages.innerHTML = "";

  loadChatHistory();
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
    <button class="delete-chat" onclick="deleteChat(${chat.id}, event)">🗑</button>
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

  // ✅ THIS LINE FIXES HIGHLIGHTING
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
// static/dashboard.js
// Shared JavaScript for chat.html and admin_dashboard.html

// ==============================================
// INITIALIZE DOM ELEMENTS
// ==============================================

let chatMessages, messageInput, sendButton;

// Wait for DOM to load before initializing
document.addEventListener("DOMContentLoaded", async function () {
  chatMessages = document.getElementById("chatMessages");
  messageInput = document.getElementById("messageInput");
  sendButton = document.getElementById("sendButton");

  // Setup event listeners if elements exist
  if (sendButton) {
    sendButton.addEventListener("click", sendMessage);
  }

  if (messageInput) {
    messageInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        sendMessage();
      }
    });
  }

  // Check if we're on admin page and setup admin features
  const isAdminPage = document.getElementById("uploadForm") !== null;
  if (isAdminPage) {
    setupAdminFeatures();
    loadDocuments();
  }

  await initializeChat();
  // loadChatHistory();
  // createNewChat();
  loadNotifications();
  loadRequests();
  console.log("Dashboard JS initialized successfully");
});

// ==============================================
// COMMON FUNCTIONS
// ==============================================

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
function handleLogout() {
  if (confirm("Are you sure you want to logout?")) {
    localStorage.clear();
    sessionStorage.clear();
    window.location.href = "/logout";
  }
}

function getCurrentTime() {
  const now = new Date();
  return now.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function scrollToBottom() {
  if (chatMessages) {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}

function addMessage(text, isUser = false) {
  const messageDiv = document.createElement("div");
  messageDiv.className = `message ${isUser ? "user" : "assistant"}`;

  const formattedText = isUser ? text : marked.parse(text);

  messageDiv.innerHTML = `
      <div class="message-avatar">
        ${isUser ? "🧑" : "🤖"}
      </div>
      <div class="message-bubble">
        ${formattedText}
      </div>
  `;

  chatMessages.appendChild(messageDiv);
  scrollToBottom();
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
      bubble.innerHTML = marked.parse(currentText);
      i++;
      scrollToBottom();
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
  scrollToBottom();
}

function hideTypingIndicator() {
  const typingIndicator = document.getElementById("typingIndicator");
  if (typingIndicator) {
    typingIndicator.remove();
  }
}

async function sendMessage() {
  if (!messageInput || !chatMessages) {
    console.error("Required elements not found");
    return;
  }

  const message = messageInput.value.trim();
  if (!message) return;

  // Add user message
  addMessage(message, true);
  messageInput.value = "";

  // Show typing indicator
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

      // refresh sidebar title
      loadChatHistory();
    } else {
      addMessage("Sorry, something went wrong. Please try again.");
    }
  } catch (error) {
    console.error("Error:", error);
    hideTypingIndicator();
    addMessage("Sorry, something went wrong. Please try again.");
  }
}

function sendSuggestion(text) {
  if (messageInput) {
    messageInput.value = text;
    sendMessage();
  }
}

function insertEmoji() {
  const emojis = ["😊"];
  const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
  messageInput.value += randomEmoji;
  messageInput.focus();
}

// ==============================================
// ADMIN-SPECIFIC FUNCTIONS
// ==============================================

function setupAdminFeatures() {
  const pdfFileInput = document.getElementById("pdfFile");
  if (pdfFileInput) {
    pdfFileInput.addEventListener("change", function (e) {
      const fileName =
        e.target.files[0]?.name || "Choose PDF file to upload...";
      const fileNameSpan = document.getElementById("fileName");
      if (fileNameSpan) {
        fileNameSpan.textContent = fileName;
      }
    });
  }

  const uploadForm = document.getElementById("uploadForm");
  if (uploadForm) {
    uploadForm.addEventListener("submit", handleUpload);
  }
}

async function handleUpload(e) {
  e.preventDefault();

  const formData = new FormData();
  const fileInput = document.getElementById("pdfFile");
  const uploadBtn = document.getElementById("uploadBtn");
  const statusDiv = document.getElementById("uploadStatus");

  if (!fileInput || !fileInput.files[0]) {
    alert("Please select a PDF file first!");
    return;
  }

  formData.append("file", fileInput.files[0]);

  if (statusDiv) {
    statusDiv.style.background = "#e3f2fd";
    statusDiv.style.padding = "12px";
    statusDiv.style.borderRadius = "8px";
    statusDiv.innerHTML =
      '<p style="color: #1976d2; margin: 0;"><i class="fas fa-spinner fa-spin"></i> Uploading and processing PDF...</p>';
  }

  if (uploadBtn) {
    uploadBtn.disabled = true;
    uploadBtn.innerHTML =
      '<i class="fas fa-spinner fa-spin"></i> Processing...';
  }

  try {
    const response = await fetch("/admin/upload", {
      method: "POST",
      body: formData,
    });

    const result = await response.json();

    if (result.success) {
      if (statusDiv) {
        statusDiv.style.background = "#e8f5e9";
        statusDiv.innerHTML = `<p style="color: #2e7d32; margin: 0;"><i class="fas fa-check-circle"></i> ${result.message}</p>`;
      }
      fileInput.value = "";
      const fileNameSpan = document.getElementById("fileName");
      if (fileNameSpan) {
        fileNameSpan.textContent = "Choose PDF file to upload...";
      }
      loadDocuments();

      setTimeout(() => {
        if (statusDiv) {
          statusDiv.innerHTML = "";
          statusDiv.style.padding = "0";
        }
      }, 5000);
    } else {
      if (statusDiv) {
        statusDiv.style.background = "#ffebee";
        statusDiv.innerHTML = `<p style="color: #c62828; margin: 0;"><i class="fas fa-exclamation-circle"></i> ${result.message}</p>`;
      }
    }
  } catch (error) {
    if (statusDiv) {
      statusDiv.style.background = "#ffebee";
      statusDiv.innerHTML = `<p style="color: #c62828; margin: 0;"><i class="fas fa-exclamation-circle"></i> Upload failed: ${error.message}</p>`;
    }
  } finally {
    if (uploadBtn) {
      uploadBtn.disabled = false;
      uploadBtn.innerHTML = '<i class="fas fa-upload"></i> Upload PDF';
    }
  }
}

async function loadDocuments() {
  try {
    const response = await fetch("/admin/documents");
    const result = await response.json();

    const docsList = document.getElementById("documentsList");
    if (!docsList) return;

    if (result.success && result.documents.length > 0) {
      docsList.innerHTML = result.documents
        .map(
          (doc) => `
        <div class="doc-item">
          <strong><i class="fas fa-file-pdf"></i> ${doc.filename}</strong>
          <small>
            Status: <span style="color: ${
              doc.status === "completed"
                ? "#2e7d32"
                : doc.status === "failed"
                  ? "#c62828"
                  : "#f57c00"
            }; font-weight: 600;">
              ${
                doc.status === "completed"
                  ? "✅"
                  : doc.status === "failed"
                    ? "❌"
                    : "⏳"
              } ${doc.status}
            </span><br>
            Chunks: <strong>${
              doc.chunks_count || "N/A"
            }</strong> | Size: <strong>${doc.file_size}</strong><br>
            Uploaded: ${doc.uploaded_at}<br>
            By: ${doc.uploaded_by}
          </small>
          <button class="delete-btn" onclick="deleteDoc(${doc.id})">
            <i class="fas fa-trash-alt"></i> Delete
          </button>
        </div>
      `,
        )
        .join("");
    } else {
      docsList.innerHTML = `
        <div class="empty-state">
          <i class="fas fa-file-pdf"></i>
          <p>No documents uploaded yet</p>
        </div>
      `;
    }
  } catch (error) {
    console.error("Error loading documents:", error);
  }
}

async function deleteDoc(docId) {
  if (!confirm("Are you sure you want to delete this document?")) return;

  try {
    const response = await fetch(`/admin/delete/${docId}`, {
      method: "DELETE",
    });

    const result = await response.json();

    if (result.success) {
      alert("✅ " + result.message);
      loadDocuments();
    } else {
      alert("❌ " + result.message);
    }
  } catch (error) {
    alert("❌ Delete failed: " + error.message);
  }
}

// Make deleteDoc global so it can be called from HTML
window.deleteDoc = deleteDoc;

function openSection(section) {
  document.querySelectorAll(".section").forEach((s) => {
    s.classList.remove("active");
  });

  document.getElementById(section + "-section").classList.add("active");

  document.querySelectorAll(".menu-item").forEach((i) => {
    i.classList.remove("active");
  });

  event.target.classList.add("active");
}

function toggleNotificationPopup() {
  const popup = document.getElementById("notificationPopup");

  popup.style.display = popup.style.display === "block" ? "none" : "block";
}

// ===============================
// PROFILE MODAL FUNCTIONS
// ===============================

function openProfileModal() {
  const modal = document.getElementById("profileModal");
  if (modal) {
    modal.style.display = "flex";
  }
}

function closeProfileModal() {
  const modal = document.getElementById("profileModal");
  if (modal) {
    modal.style.display = "none";
  }
}

async function requestAdminAccess() {
  try {
    const response = await fetch("/admin/request", {
      method: "POST",
    });

    const data = await response.json();

    const status = document.getElementById("requestStatus");
    if (status) {
      status.innerText = data.message;
    }
  } catch (err) {
    console.error("Admin request failed", err);
  }
}

async function loadNotifications() {
  const response = await fetch("/notifications");
  const data = await response.json();

  const count = document.getElementById("notifCount");

  if (count) {
    count.innerText = data.length;
  }
}

document.addEventListener("DOMContentLoaded", function () {
  loadNotifications();
  loadRequests();
});

async function loadRequests() {
  const response = await fetch("/admin/requests");

  const requests = await response.json();

  const container = document.getElementById("requestList");

  container.innerHTML = "";

  requests.forEach((r) => {
    const div = document.createElement("div");

    div.className = "notification";

    div.innerHTML = `
        <strong>${r.username}</strong> (${r.email})

        <br><br>

        <button onclick="approveRequest(${r.id})">Approve</button>

        <button onclick="rejectRequest(${r.id})">Reject</button>
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
}

async function rejectRequest(id) {
  await fetch(`/admin/reject/${id}`, {
    method: "POST",
  });

  loadRequests();
}

function toggleNotificationPopup() {
  const popup = document.getElementById("notificationPopup");

  if (popup.style.display === "block") {
    popup.style.display = "none";
  } else {
    popup.style.display = "block";
    loadNotificationPopup();
  }
}

async function loadNotificationPopup() {
  const response = await fetch("/notifications");
  const data = await response.json();

  const list = document.getElementById("notificationList");
  list.innerHTML = "";

  if (data.length === 0) {
    list.innerHTML =
      "<p style='text-align:center; opacity:0.6;'>No notifications</p>";
    return;
  }

  data.forEach((n) => {
    const div = document.createElement("div");

    div.className = "notification-item";

    // 🎨 TYPE BASED STYLE
    if (n.type === "upload") {
      div.style.borderLeft = "4px solid #3b82f6";
    } else if (n.type === "request") {
      div.style.borderLeft = "4px solid #10b981";
    }

    div.innerHTML = `
      <div>${n.text}</div>
      <small>${n.time}</small>
    `;

    list.appendChild(div);
  });
}

const socket = io();

socket.on("new_notification", function (data) {
  const badge = document.getElementById("notifCount");
  const list = document.getElementById("notificationList");

  if (badge) {
    badge.innerText = parseInt(badge.innerText || 0) + 1;
  }

  if (list) {
    const div = document.createElement("div");

    div.className = "notification-item";

    div.innerHTML = `
${data.text}
<br>
<small>${data.time}</small>
`;

    list.prepend(div);
  }
});

const sidebar = document.querySelector(".sidebar");
const toggleBtn = document.querySelector(".menu-toggle");

if (toggleBtn) {
  toggleBtn.addEventListener("click", () => {
    sidebar.classList.toggle("collapsed");
  });
}
