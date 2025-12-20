// static/dashboard.js
// Shared JavaScript for chat.html and admin_dashboard.html

// ==============================================
// INITIALIZE DOM ELEMENTS
// ==============================================
let chatMessages, messageInput, sendButton;

// Wait for DOM to load before initializing
document.addEventListener("DOMContentLoaded", function () {
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

  console.log("Dashboard JS initialized successfully");
});

// ==============================================
// COMMON FUNCTIONS
// ==============================================

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
  if (!chatMessages) {
    console.error("chatMessages element not found");
    return;
  }

  // Remove welcome message if exists
  const welcomeMsg = chatMessages.querySelector(".welcome-message");
  if (welcomeMsg) {
    welcomeMsg.remove();
  }

  const messageDiv = document.createElement("div");
  messageDiv.className = `message ${
    isUser ? "user-message" : "assistant-message"
  }`;

  messageDiv.innerHTML = `
    <div class="message-avatar">
      <i class="fas fa-${isUser ? "user" : "robot"}"></i>
    </div>
    <div class="message-content">
      ${text}
      <span class="message-time">${getCurrentTime()}</span>
    </div>
  `;

  chatMessages.appendChild(messageDiv);
  scrollToBottom();
}

function showTypingIndicator() {
  if (!chatMessages) return;

  const typingDiv = document.createElement("div");
  typingDiv.className = "message assistant-message";
  typingDiv.id = "typingIndicator";

  typingDiv.innerHTML = `
    <div class="message-avatar">
      <i class="fas fa-robot"></i>
    </div>
    <div class="typing-indicator active">
      <div class="typing-dots">
        <span></span>
        <span></span>
        <span></span>
      </div>
    </div>
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

  try {
    const response = await fetch("/get", {
      method: "POST",
      body: formData,
    });

    hideTypingIndicator();

    if (response.ok) {
      const botResponse = await response.text();
      addMessage(botResponse);
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
  const emojis = ["😊", "👍", "❤️", "🎉", "🤔", "👋", "✨", "🚀"];
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
      `
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
