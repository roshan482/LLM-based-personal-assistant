from datetime import datetime, timedelta
from src.helper import load_document
from flask_socketio import SocketIO, emit, join_room, leave_room
import os
import certifi
import traceback
from datetime import datetime
from functools import wraps

os.environ["SSL_CERT_FILE"] = certifi.where()

from flask import Flask, render_template, jsonify, redirect, url_for, request, session, flash
from flask_sqlalchemy import SQLAlchemy
from flask_mail import Mail, Message
from itsdangerous import URLSafeTimedSerializer
from dotenv import load_dotenv
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename
from sqlalchemy import func
from authlib.integrations.flask_client import OAuth
from src.helper import (
    download_hugging_face_embeddings,
    load_document,
    filter_to_minimal_docs,
    text_split,
    text_split_large,
    process_chunks_in_batches,
)
from src.prompt import system_prompt
from langchain_pinecone import PineconeVectorStore
from langchain_groq import ChatGroq
from langchain_classic.chains import create_retrieval_chain
from langchain_classic.chains.combine_documents import create_stuff_documents_chain
from langchain_core.prompts import ChatPromptTemplate
from pinecone import Pinecone, ServerlessSpec
import tempfile
import shutil
import threading

MAX_UPLOAD_BYTES = 50 * 1024 * 1024

load_dotenv()

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*")
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'dev-secret-for-local-testing-2026')
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///personal_assistant.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {'pool_pre_ping': True}
app.config['MAIL_SERVER'] = os.getenv("MAIL_SERVER", 'smtp.gmail.com')
app.config['MAIL_PORT'] = int(os.getenv("MAIL_PORT", 587))
app.config['MAIL_USE_TLS'] = True
app.config['MAIL_USE_SSL'] = False
app.config['MAIL_USERNAME'] = os.getenv("MAIL_USERNAME")
app.config['MAIL_PASSWORD'] = os.getenv("MAIL_PASSWORD")
app.config['MAIL_DEFAULT_SENDER'] = os.getenv("MAIL_USERNAME")
app.config['UPLOAD_FOLDER'] = 'uploads/'

db = SQLAlchemy(app)
mail = Mail(app)
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

def get_reset_serializer():
    return URLSafeTimedSerializer(app.config['SECRET_KEY'], salt='password-reset-salt')

ALLOWED_EXTENSIONS = {'pdf', 'txt', 'xlsx', 'png', 'jpg', 'jpeg'}

oauth = OAuth(app)
google = oauth.register(
    name='google',
    client_id=os.getenv("GOOGLE_CLIENT_ID"),
    client_secret=os.getenv("GOOGLE_CLIENT_SECRET"),
    server_metadata_url='https://accounts.google.com/.well-known/openid-configuration',
    client_kwargs={'scope': 'openid email profile'}
)

PINECONE_API_KEY = os.getenv("PINECONE_API_KEY")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
if PINECONE_API_KEY:
    os.environ["PINECONE_API_KEY"] = PINECONE_API_KEY
if GROQ_API_KEY:
    os.environ["GROQ_API_KEY"] = GROQ_API_KEY

index_name = "personal-assistant"

try:
    pc = Pinecone(api_key=PINECONE_API_KEY)
    if index_name not in [i.name for i in pc.list_indexes()]:
        pc.create_index(
            name=index_name, dimension=384, metric="cosine",
            spec=ServerlessSpec(cloud="aws", region="us-east-1")
        )
    embeddings = download_hugging_face_embeddings()
    docsearch = PineconeVectorStore.from_existing_index(index_name=index_name, embedding=embeddings)
    retriever = docsearch.as_retriever(search_type="similarity", search_kwargs={"k": 6})
    chatModel = ChatGroq(model="llama-3.1-8b-instant", temperature=0, max_tokens=512, groq_api_key=GROQ_API_KEY)
    prompt = ChatPromptTemplate.from_messages([("system", system_prompt), ("human", "{input}")])
    question_answer_chain = create_stuff_documents_chain(chatModel, prompt)
    rag_chain = create_retrieval_chain(retriever, question_answer_chain)
except Exception as e:
    print("\n===== RAG INITIALIZATION ERROR =====")
    traceback.print_exc()
    rag_chain = None

# ─────────────────────────────────────────
# DATABASE MODELS
# ─────────────────────────────────────────

class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    role = db.Column(db.String(20), default='user', nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)

class ChatSession(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'))
    title = db.Column(db.String(255))
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

class ChatMessage(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    session_id = db.Column(db.Integer, db.ForeignKey('chat_session.id'))
    role = db.Column(db.String(20))
    content = db.Column(db.Text)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

class UploadedDocument(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    filename = db.Column(db.String(255), nullable=False)
    original_filename = db.Column(db.String(255), nullable=False)
    uploaded_by = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    uploaded_at = db.Column(db.DateTime, default=datetime.utcnow)
    file_size = db.Column(db.Integer)
    chunks_count = db.Column(db.Integer)
    status = db.Column(db.String(20), default='processing')
    user = db.relationship('User', backref='uploaded_documents')

class AdminRequest(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'))
    status = db.Column(db.String(20), default="pending")
    
    id_card_path = db.Column(db.String(255))
    reason = db.Column(db.Text)
    
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    user = db.relationship('User', backref='admin_requests')  # ✅ ADD THIS

class DocumentReadEvent(db.Model):
    """Tracks every time a user query retrieves content from an uploaded document."""
    __tablename__ = 'document_read_event'
    id          = db.Column(db.Integer, primary_key=True)
    document_id = db.Column(db.Integer, db.ForeignKey('uploaded_document.id'), nullable=False)
    user_id     = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    query_text  = db.Column(db.Text, nullable=False)
    read_at     = db.Column(db.DateTime, default=datetime.utcnow)
    document    = db.relationship('UploadedDocument', backref='read_events')
    user        = db.relationship('User', backref='read_events')

# ─────────────────────────────────────────
# ONLINE USER TRACKING  (in-memory)
# ─────────────────────────────────────────
# { user_id -> { username, role, sid, since } }
_online_users: dict = {}
_online_lock = threading.Lock()

def _broadcast_online():
    with _online_lock:
        payload = list(_online_users.values())
    socketio.emit("online_users_update", {"users": payload, "count": len(payload)}, namespace="/")

@socketio.on("connect")
def handle_connect():
    uid = session.get("user_id")
    if uid:
        join_room(f"user_{uid}")
        user = User.query.get(uid)
        if user:
            with _online_lock:
                _online_users[uid] = {
                    "user_id":  uid,
                    "username": user.username,
                    "role":     user.role,
                    "sid":      request.sid,
                    "since":    datetime.utcnow().strftime("%H:%M"),
                }
            _broadcast_online()

@socketio.on("disconnect")
def handle_disconnect():
    uid = session.get("user_id")
    if uid:
        with _online_lock:
            _online_users.pop(uid, None)
        _broadcast_online()

# ─────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'user_id' not in session:
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated

def role_required(role):
    def decorator(f):
        @wraps(f)
        def decorated(*args, **kwargs):
            if 'user_id' not in session:
                return redirect(url_for('login'))
            user = User.query.get(session['user_id'])
            if not user:
                session.clear()
                return redirect(url_for('login'))
            if user.role != role:
                return redirect(url_for('dashboard'))
            return f(*args, **kwargs)
        return decorated
    return decorator

def send_reset_email(email, reset_url):
    try:
        msg = Message("🔐 Password Reset", sender=app.config['MAIL_USERNAME'], recipients=[email])
        msg.html = f"<h2>Reset Password</h2><a href='{reset_url}' style='background:#3b82f6;color:white;padding:12px 24px;border-radius:8px;'>Reset Password</a>"
        msg.body = f"Reset: {reset_url}"
        mail.send(msg)
        return True
    except Exception:
        return False

# ─────────────────────────────────────────
# AUTH ROUTES
# ─────────────────────────────────────────

@app.route('/')
def land():
    return render_template('Landing_Page.html')

@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        identifier = request.form.get('username', '').strip()
        password = request.form.get('password')
        if not identifier or not password:
            flash('Please enter username/email and password!', 'error')
            return render_template('login.html')
        user = User.query.filter((User.username == identifier) | (User.email == identifier)).first()
        if user and user.check_password(password):
            session['user_id'] = user.id
            session['role'] = user.role
            flash('Login successful! Welcome back.', 'success')
            return redirect(url_for('admin') if user.role == 'admin' else url_for('dashboard'))
        else:
            flash('Invalid username, email, or password!', 'error')
    return render_template('login.html')

@app.route('/register', methods=['GET', 'POST'])
def register():
    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        email = request.form.get('email', '').strip()
        password = request.form.get('password')
        if not all([username, email, password]):
            flash('Please fill all fields!', 'error')
            return render_template('register.html')
        if len(password) < 6:
            flash('Password must be at least 6 characters!', 'error')
            return render_template('register.html')
        if len(username) < 3:
            flash('Username must be at least 3 characters!', 'error')
            return render_template('register.html')
        if User.query.filter((User.username == username) | (User.email == email)).first():
            flash('Username or email already exists!', 'error')
        else:
            try:
                user = User(username=username, email=email,
                            password_hash=generate_password_hash(password), role='user')
                db.session.add(user)
                db.session.commit()
                flash(f'✅ Welcome {username}! Please login.', 'success')
                return redirect(url_for('login'))
            except Exception:
                db.session.rollback()
                flash('Registration failed. Try again.', 'error')
    return render_template('register.html')

@app.route('/forgot-password', methods=['GET', 'POST'])
def forgot_password():
    if request.method == 'POST':
        email = request.form.get('email', '').strip()
        if not email:
            flash('Please enter your email!', 'error')
            return render_template('forgot_password.html')
        user = User.query.filter_by(email=email).first()
        if user:
            try:
                s = get_reset_serializer()
                token = s.dumps(email)
                reset_url = url_for('reset_password', token=token, _external=True)
                if send_reset_email(email, reset_url):
                    flash('✅ Check your email for reset link!', 'success')
                else:
                    flash('❌ Email failed.', 'error')
            except Exception:
                flash('Failed to send reset link. Try again.', 'error')
        else:
            flash('No account found with that email. Register first?', 'error')
    return render_template('forgot_password.html')

@app.route('/reset-password/<token>', methods=['GET', 'POST'])
def reset_password(token):
    try:
        s = get_reset_serializer()
        email = s.loads(token, max_age=3600)
    except Exception:
        flash('❌ Invalid or expired link! Request a new one.', 'error')
        return redirect(url_for('login'))
    user = User.query.filter_by(email=email).first()
    if not user:
        flash('User not found! Please register.', 'error')
        return redirect(url_for('login'))
    if request.method == 'POST':
        password = request.form.get('password', '').strip()
        confirm = request.form.get('confirm_password', '').strip()
        if not password or len(password) < 6:
            flash('Password must be at least 6 characters!', 'error')
            return render_template('reset_password.html', token=token)
        if password != confirm:
            flash('Passwords do not match!', 'error')
            return render_template('reset_password.html', token=token)
        try:
            user.password_hash = generate_password_hash(password)
            db.session.commit()
            flash('🎉 Password reset successful! You can now login.', 'success')
            return redirect(url_for('login'))
        except Exception:
            db.session.rollback()
            flash('Reset failed. Try again.', 'error')
    return render_template('reset_password.html', token=token)

@app.route('/dashboard')
@login_required
def dashboard():
    user = User.query.get(session['user_id'])
    if not user:
        flash('Session expired. Please login again.', 'error')
        return redirect(url_for('login'))
    if user.role == "admin":
        return redirect(url_for('admin'))
    return render_template('chat.html', user=user)

@app.route('/user/profile')
@login_required
def user_profile():
    user = User.query.get(session['user_id'])
    if not user:
        return jsonify({"success": False, "message": "User not found"}), 404
    return jsonify({"success": True, "user": {
        "id": user.id, "username": user.username, "email": user.email, "role": user.role
    }})

@app.route('/login/google')
def google_login():
    return google.authorize_redirect(url_for('google_callback', _external=True), prompt="consent")

@app.route('/google/callback')
def google_callback():
    token = google.authorize_access_token()
    resp = google.get('https://openidconnect.googleapis.com/v1/userinfo')
    user_info = resp.json()
    email = user_info["email"]
    username = email.split("@")[0]
    user = User.query.filter_by(email=email).first()
    if not user:
        if User.query.filter_by(username=username).first():
            username = username + str(int(datetime.utcnow().timestamp()))
        user = User(username=username, email=email,
                    password_hash=generate_password_hash("oauth_user"), role="user")
        db.session.add(user)
        db.session.commit()
    session['user_id'] = user.id
    session['role'] = user.role
    return redirect(url_for('dashboard'))

# ─────────────────────────────────────────
# ADMIN ROUTES
# ─────────────────────────────────────────

@app.route('/admin')
@role_required('admin')
def admin():
    user = User.query.get(session['user_id'])
    documents = UploadedDocument.query.order_by(UploadedDocument.uploaded_at.desc()).all()
    return render_template('admin_dashboard.html', user=user, documents=documents)

    
@app.route("/admin/request", methods=["POST"])
@login_required
def request_admin():
    try:
        user_id = session["user_id"]
        user    = User.query.get(user_id)

        file   = request.files.get("id_card")
        reason = request.form.get("reason", "").strip()

        if not file or file.filename == "":
            return jsonify({"success": False, "message": "ID card is required"}), 400

        # Validate file type
        allowed_mime = {"image/jpeg", "image/png", "image/jpg", "application/pdf"}
        if file.content_type not in allowed_mime:
            return jsonify({"success": False, "message": "Only JPG, PNG or PDF files are allowed"}), 400

        # Build a safe, unique filename so collisions never overwrite another user's ID
        ext = os.path.splitext(file.filename)[1].lower() or ".jpg"
        safe_name = f"user_{user_id}_{int(datetime.utcnow().timestamp())}{ext}"
        upload_folder = os.path.join("static", "uploads", "id_cards")
        os.makedirs(upload_folder, exist_ok=True)
        filepath = os.path.join(upload_folder, safe_name)
        file.save(filepath)

        existing = AdminRequest.query.filter_by(user_id=user_id).first()

        if existing:
            if existing.status == "pending":
                return jsonify({"success": False, "message": "Your request is already pending review"})
            if existing.status == "approved":
                return jsonify({"success": False, "message": "You are already an admin"})
            # Rejected before — allow re-submission
            existing.status     = "pending"
            existing.id_card_path = filepath
            existing.reason     = reason
            existing.created_at = datetime.utcnow()
        else:
            existing = AdminRequest(
                user_id=user_id,
                id_card_path=filepath,
                reason=reason,
                status="pending"
            )
            db.session.add(existing)

        db.session.commit()

        # ── Notify all existing admins by email ───────────────────────
        try:
            admins = User.query.filter_by(role="admin").all()
            admin_emails = [a.email for a in admins if a.email]
            if admin_emails:
                reason_html = f"<p><strong>Reason:</strong> {reason}</p>" if reason else ""
                msg = Message(
                    subject=f"🛡️ New Admin Request from {user.username}",
                    sender=app.config['MAIL_USERNAME'],
                    recipients=admin_emails
                )
                msg.html = f"""
                <div style="font-family:sans-serif;max-width:520px;margin:auto;background:#0f172a;color:#f1f5f9;border-radius:12px;overflow:hidden;">
                  <div style="background:linear-gradient(135deg,#1e3a5f,#0f172a);padding:24px 28px;border-bottom:1px solid rgba(255,255,255,0.08);">
                    <h2 style="margin:0;color:#60a5fa;">🛡️ Admin Access Request</h2>
                  </div>
                  <div style="padding:24px 28px;">
                    <p><strong style="color:#93c5fd;">User:</strong> {user.username}</p>
                    <p><strong style="color:#93c5fd;">Email:</strong> {user.email}</p>
                    {reason_html}
                    <p style="color:#94a3b8;font-size:13px;">Login to the admin panel to review the submitted ID card and approve or reject this request.</p>
                  </div>
                </div>"""
                msg.body = f"New admin request from {user.username} ({user.email}). Reason: {reason or 'Not provided'}. Please log in to review."
                mail.send(msg)
        except Exception as mail_err:
            print(f"[mail] Admin notification failed: {mail_err}")
            # Don't fail the whole request just because email failed

        # ── Real-time push to admin sockets ───────────────────────────
        socketio.emit("new_notification", {
            "text": f"{user.username} requested admin access",
            "time": datetime.utcnow().strftime("%H:%M"),
            "type": "request"
        })

        return jsonify({"success": True, "message": "Request submitted! Admins have been notified."})

    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "message": f"Server error: {str(e)}"})

@app.route("/admin/approve/<int:req_id>", methods=["POST"])
@role_required("admin")
def approve_request(req_id):
    req  = AdminRequest.query.get_or_404(req_id)
    user = User.query.get_or_404(req.user_id)
    user.role   = "admin"
    req.status  = "approved"
    db.session.commit()

    # Real-time in-app notification
    socketio.emit("new_notification", {
        "text": "Your admin request has been APPROVED 🎉",
        "time": datetime.utcnow().strftime("%H:%M"),
        "type": "request"
    }, room=f"user_{user.id}")

    # Email the user
    try:
        msg = Message(
            subject="✅ Admin Access Approved!",
            sender=app.config['MAIL_USERNAME'],
            recipients=[user.email]
        )
        msg.html = f"""
        <div style="font-family:sans-serif;max-width:480px;margin:auto;background:#0f172a;color:#f1f5f9;border-radius:12px;overflow:hidden;">
          <div style="background:linear-gradient(135deg,#065f46,#0f172a);padding:24px 28px;border-bottom:1px solid rgba(255,255,255,0.08);">
            <h2 style="margin:0;color:#34d399;">✅ Request Approved</h2>
          </div>
          <div style="padding:24px 28px;">
            <p>Hi <strong>{user.username}</strong>,</p>
            <p>Your admin access request has been <strong style="color:#34d399;">approved</strong>! You can now log in and access the Admin Dashboard.</p>
            <p style="color:#94a3b8;font-size:13px;">If you have any questions, contact your system administrator.</p>
          </div>
        </div>"""
        msg.body = f"Hi {user.username}, your admin access request has been approved. You can now log in to the Admin Dashboard."
        mail.send(msg)
    except Exception as mail_err:
        print(f"[mail] Approval email failed: {mail_err}")

    return jsonify({"message": "User promoted to admin", "success": True})

@app.route("/admin/reject/<int:req_id>", methods=["POST"])
@role_required("admin")
def reject_request(req_id):
    req  = AdminRequest.query.get_or_404(req_id)
    user = User.query.get_or_404(req.user_id)
    req.status = "rejected"
    db.session.commit()

    # Real-time in-app notification
    socketio.emit("new_notification", {
        "text": "Your admin request has been REJECTED",
        "time": datetime.utcnow().strftime("%H:%M"),
        "type": "request"
    }, room=f"user_{req.user_id}")

    # Email the user
    try:
        msg = Message(
            subject="❌ Admin Access Request Rejected",
            sender=app.config['MAIL_USERNAME'],
            recipients=[user.email]
        )
        msg.html = f"""
        <div style="font-family:sans-serif;max-width:480px;margin:auto;background:#0f172a;color:#f1f5f9;border-radius:12px;overflow:hidden;">
          <div style="background:linear-gradient(135deg,#7f1d1d,#0f172a);padding:24px 28px;border-bottom:1px solid rgba(255,255,255,0.08);">
            <h2 style="margin:0;color:#f87171;">❌ Request Rejected</h2>
          </div>
          <div style="padding:24px 28px;">
            <p>Hi <strong>{user.username}</strong>,</p>
            <p>Unfortunately your admin access request has been <strong style="color:#f87171;">rejected</strong>.</p>
            <p style="color:#94a3b8;font-size:13px;">If you believe this is a mistake, please contact your system administrator and re-submit with a clearer ID card.</p>
          </div>
        </div>"""
        msg.body = f"Hi {user.username}, your admin access request has been rejected. Contact your administrator for more information."
        mail.send(msg)
    except Exception as mail_err:
        print(f"[mail] Rejection email failed: {mail_err}")

    return jsonify({"message": "Request rejected", "success": True})

@app.route("/admin/notifications")
@role_required("admin")
def admin_notifications():
    reqs = AdminRequest.query.order_by(AdminRequest.created_at.desc()).all()
    uploads = UploadedDocument.query.order_by(UploadedDocument.uploaded_at.desc()).all()
    notifications = []
    for r in reqs:
        notifications.append({"text": f"{r.user.username} requested admin access",
                               "time": r.created_at.strftime("%H:%M"), "type": "request"})
    for u in uploads:
        uploader = User.query.get(u.uploaded_by)
        notifications.append({"text": f"{uploader.username} uploaded {u.filename}",
                               "time": u.uploaded_at.strftime("%H:%M"), "type": "upload"})
    return jsonify(notifications)

# ── Online Users ──────────────────────────────────────────────────────────────
@app.route("/admin/online-users")
@role_required("admin")
def get_online_users():
    with _online_lock:
        users = list(_online_users.values())
    return jsonify({"success": True, "users": users, "count": len(users)})

# ── Document Read Tracking ─────────────────────────────────────────────────────
@app.route("/admin/doc-readers/<int:doc_id>")
@role_required("admin")
def get_doc_readers(doc_id):
    doc = UploadedDocument.query.get(doc_id)
    if not doc:
        return jsonify({"success": False, "message": "Document not found"})
    events = (DocumentReadEvent.query
              .filter_by(document_id=doc_id)
              .order_by(DocumentReadEvent.read_at.desc()).all())
    readers = {}
    for ev in events:
        uid = ev.user_id
        if uid not in readers:
            readers[uid] = {
                "user_id":     uid,
                "username":    ev.user.username,
                "email":       ev.user.email,
                "first_read":  ev.read_at.strftime("%Y-%m-%d %H:%M"),
                "last_read":   ev.read_at.strftime("%Y-%m-%d %H:%M"),
                "query_count": 0,
                "queries":     []
            }
        readers[uid]["query_count"] += 1
        readers[uid]["queries"].append({
            "text": ev.query_text,
            "time": ev.read_at.strftime("%Y-%m-%d %H:%M")
        })
        if ev.read_at.strftime("%Y-%m-%d %H:%M") < readers[uid]["first_read"]:
            readers[uid]["first_read"] = ev.read_at.strftime("%Y-%m-%d %H:%M")
    return jsonify({
        "success":     True,
        "document":    doc.filename,
        "readers":     list(readers.values()),
        "total_reads": len(events)
    })

@app.route("/admin/doc-stats")
@role_required("admin")
def get_doc_stats():
    docs = UploadedDocument.query.filter_by(status="completed").all()
    stats = []
    for doc in docs:
        total = DocumentReadEvent.query.filter_by(document_id=doc.id).count()
        unique = db.session.query(
            func.count(func.distinct(DocumentReadEvent.user_id))
        ).filter(DocumentReadEvent.document_id == doc.id).scalar()
        stats.append({
            "id": doc.id, "filename": doc.filename,
            "total_reads": total, "unique_users": unique,
            "uploaded_at": doc.uploaded_at.strftime("%Y-%m-%d %H:%M"),
        })
    return jsonify({"success": True, "stats": stats})

# ── Upload ─────────────────────────────────────────────────────────────────────
_upload_progress: dict = {}

def _process_document_background(app_ctx, doc_id, filepath, file_size, user_id, filename):
    def _emit(event, payload):
        _upload_progress[doc_id] = payload
        try:
            socketio.emit(event, payload, namespace="/")
        except Exception:
            pass

    with app_ctx:
        try:
            _emit("upload_progress", {"doc_id": doc_id, "stage": "parsing", "pct": 5, "label": "📄 Parsing document…"})
            documents = load_document(filepath)
            docs = filter_to_minimal_docs(documents)
            _emit("upload_progress", {"doc_id": doc_id, "stage": "chunking", "pct": 20, "label": "✂️ Splitting into chunks…"})
            chunks = text_split_large(docs, file_size_bytes=file_size)
            total_chunks = len(chunks)
            if docsearch is None:
                raise RuntimeError("Vector store not initialized.")
            _emit("upload_progress", {"doc_id": doc_id, "stage": "indexing", "pct": 25,
                                      "total_chunks": total_chunks, "done_chunks": 0,
                                      "label": f"🔗 Indexing 0 / {total_chunks} chunks…"})

            def _progress_cb(done, total):
                pct = 25 + int((done / total) * 65)
                _emit("upload_progress", {"doc_id": doc_id, "stage": "indexing", "pct": pct,
                                          "done_chunks": done, "total_chunks": total,
                                          "label": f"🔗 Indexing {done} / {total} chunks…"})

            batch_sz = 50 if total_chunks > 200 else 30
            attempt = 0
            while attempt <= 2:
                try:
                    processed = process_chunks_in_batches(chunks, batch_processor=docsearch.add_documents,
                                                          batch_size=batch_sz, max_workers=1,
                                                          progress_callback=_progress_cb)
                    break
                except Exception as e:
                    attempt += 1
                    if attempt > 2:
                        raise e

            doc = UploadedDocument.query.get(doc_id)
            doc.status = "completed"
            doc.chunks_count = processed
            db.session.commit()
            _emit("upload_progress", {"doc_id": doc_id, "stage": "done", "pct": 100,
                                      "label": "✅ Done!", "message": f"{filename} indexed ({processed} chunks)", "success": True})
            socketio.emit("new_notification", {"text": f"New document uploaded: {filename}",
                                               "time": datetime.utcnow().strftime("%H:%M")})
        except Exception as exc:
            traceback.print_exc()
            try:
                doc = UploadedDocument.query.get(doc_id)
                if doc:
                    doc.status = "failed"
                    doc.chunks_count = 0
                    db.session.commit()
            except Exception:
                pass
            _emit("upload_progress", {"doc_id": doc_id, "stage": "error", "pct": 0,
                                      "label": "❌ Processing failed", "message": str(exc), "success": False})
        finally:
            def _cleanup():
                import time; time.sleep(30); _upload_progress.pop(doc_id, None)
            threading.Thread(target=_cleanup, daemon=True).start()

@app.route("/admin/upload", methods=["POST"])
@role_required("admin")
def upload_document():
    if "file" not in request.files:
        return jsonify({"success": False, "message": "No file uploaded"})
    file = request.files["file"]
    if file.filename == "":
        return jsonify({"success": False, "message": "No file selected"})
    if not allowed_file(file.filename):
        return jsonify({"success": False, "message": "Unsupported file type"})
    if request.content_length and request.content_length > MAX_UPLOAD_BYTES:
        return jsonify({"success": False, "message": f"File too large. Max {MAX_UPLOAD_BYTES//(1024*1024)} MB."})
    try:
        filename = secure_filename(file.filename)
        filepath = os.path.join(app.config["UPLOAD_FOLDER"], filename)
        file.save(filepath)
        file_size = os.path.getsize(filepath)
        if file_size > MAX_UPLOAD_BYTES:
            os.remove(filepath)
            return jsonify({"success": False, "message": f"File too large."})
        user_id = session["user_id"]
        doc = UploadedDocument(filename=filename, original_filename=file.filename,
                               uploaded_by=user_id, file_size=file_size, status="processing")
        db.session.add(doc)
        db.session.commit()
        doc_id = doc.id
        threading.Thread(target=_process_document_background,
                         args=(app.app_context(), doc_id, filepath, file_size, user_id, filename),
                         daemon=True).start()
        return jsonify({"success": True, "queued": True, "doc_id": doc_id,
                        "message": f"{filename} uploaded — processing in background…"})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "message": str(e)})

@app.route("/admin/upload/status/<int:doc_id>")
@role_required("admin")
def upload_status(doc_id):
    snapshot = _upload_progress.get(doc_id)
    if snapshot:
        return jsonify({"success": True, "progress": snapshot})
    doc = UploadedDocument.query.get(doc_id)
    if not doc:
        return jsonify({"success": False, "message": "Document not found"})
    if doc.status == "completed":
        return jsonify({"success": True, "progress": {"doc_id": doc_id, "stage": "done", "pct": 100,
                                                       "label": "✅ Done!", "success": True,
                                                       "message": f"{doc.filename} indexed ({doc.chunks_count} chunks)"}})
    if doc.status == "failed":
        return jsonify({"success": True, "progress": {"doc_id": doc_id, "stage": "error", "pct": 0,
                                                       "label": "❌ Processing failed", "success": False,
                                                       "message": "Processing failed — check server logs."}})
    return jsonify({"success": True, "progress": {"doc_id": doc_id, "stage": "parsing", "pct": 5, "label": "📄 Parsing document…"}})

@app.route("/admin/documents")
@role_required("admin")
def get_documents():
    docs = UploadedDocument.query.order_by(UploadedDocument.uploaded_at.desc()).all()
    return jsonify({"success": True, "documents": [{
        "id": d.id, "filename": d.filename, "status": d.status,
        "chunks_count": d.chunks_count, "file_size": d.file_size,
        "uploaded_at": d.uploaded_at.strftime("%Y-%m-%d %H:%M"), "uploaded_by": d.uploaded_by
    } for d in docs]})

@app.route("/admin/delete/<int:doc_id>", methods=["DELETE"])
@role_required("admin")
def delete_document(doc_id):
    doc = UploadedDocument.query.get(doc_id)
    if not doc:
        return jsonify({"success": False, "message": "Document not found"})
    filepath = os.path.join(app.config["UPLOAD_FOLDER"], doc.filename)
    if os.path.exists(filepath):
        os.remove(filepath)
    DocumentReadEvent.query.filter_by(document_id=doc_id).delete()
    db.session.delete(doc)
    db.session.commit()
    return jsonify({"success": True, "message": "Document deleted successfully"})

@app.route("/admin/requests")
@role_required("admin")
def get_requests():
    reqs = AdminRequest.query.filter_by(status="pending").order_by(AdminRequest.created_at.desc()).all()
    data = []
    for r in reqs:
        user = User.query.get(r.user_id)
        if not user:
            continue
        data.append({
            "id":           r.id,
            "username":     user.username,
            "email":        user.email,
            "reason":       r.reason or "",
            "id_card_path": r.id_card_path or "",
            "has_id_card":  bool(r.id_card_path),
            "created_at":   r.created_at.strftime("%d %b %Y, %H:%M") if r.created_at else "—"
        })
    return jsonify(data)

@app.route("/admin/request/id/<int:req_id>")
@role_required("admin")
def serve_id_card(req_id):
    """Serve the uploaded ID card file for admin review."""
    from flask import send_file, abort
    req = AdminRequest.query.get_or_404(req_id)
    if not req.id_card_path or not os.path.exists(req.id_card_path):
        abort(404)
    return send_file(req.id_card_path)

@app.route("/profile/update", methods=["POST"])
@login_required
def update_profile():
    user = User.query.get(session['user_id'])

    new_username = request.form.get("username", "").strip()
    current_password = request.form.get("current_password", "")
    new_password = request.form.get("new_password", "")

    if not user.check_password(current_password):
        return jsonify({"success": False, "message": "Current password is incorrect."})

    if new_username and new_username != user.username:
        existing = User.query.filter_by(username=new_username).first()
        if existing:
            return jsonify({"success": False, "message": "Username already taken."})
        user.username = new_username

    if new_password:
        if len(new_password) < 6:
            return jsonify({"success": False, "message": "New password must be at least 6 characters."})
        user.password_hash = generate_password_hash(new_password)

    db.session.commit()
    return jsonify({"success": True, "message": "Profile updated successfully!"})
# ─────────────────────────────────────────
# CHAT  (with document read tracking)
# ─────────────────────────────────────────

@app.route("/get", methods=["POST"])
@login_required
def chat():
    msg = request.form.get("msg")
    session_id = request.form.get("session_id")
    user_id = session.get("user_id")

    if not rag_chain:
        return "Chat system not initialized."

    response = rag_chain.invoke({"input": msg})
    answer = str(response.get("answer"))

    # ── Track document reads ───────────────────────────────────────────────
    try:
        source_docs = response.get("context", [])
        all_uploaded = UploadedDocument.query.filter_by(status="completed").all()
        uploaded_map = {d.filename: d.id for d in all_uploaded}
        matched_ids = set()

        for src_doc in source_docs:
            src_path = src_doc.metadata.get("source", "")
            src_basename = os.path.basename(src_path)
            if src_basename in uploaded_map and uploaded_map[src_basename] not in matched_ids:
                doc_id = uploaded_map[src_basename]
                matched_ids.add(doc_id)
                db.session.add(DocumentReadEvent(
                    document_id=doc_id, user_id=user_id, query_text=msg
                ))
                user_obj = User.query.get(user_id)
                doc_obj = UploadedDocument.query.get(doc_id)
                socketio.emit("doc_read_event", {
                    "doc_id":   doc_id,
                    "filename": doc_obj.filename if doc_obj else src_basename,
                    "user_id":  user_id,
                    "username": user_obj.username if user_obj else "Unknown",
                    "query":    msg,
                    "time":     datetime.utcnow().strftime("%H:%M"),
                }, namespace="/")
    except Exception as track_err:
        print(f"[tracking] {track_err}")

    # Save messages
    db.session.add(ChatMessage(session_id=session_id, role="user", content=msg))
    chat_session = ChatSession.query.get(session_id)
    if chat_session and chat_session.title == "New Chat":
        chat_session.title = msg[:40]
    db.session.add(ChatMessage(session_id=session_id, role="assistant", content=answer))
    db.session.commit()
    return answer

@app.route("/chat/new")
@login_required
def new_chat():
    new_session = ChatSession(user_id=session["user_id"], title="New Chat")
    db.session.add(new_session)
    db.session.commit()
    return jsonify({"session_id": new_session.id})

@app.route("/chat/history")
@login_required
def chat_history():
    sessions = ChatSession.query.filter_by(user_id=session["user_id"]).order_by(ChatSession.created_at.desc()).all()
    return jsonify([{"id": s.id, "title": s.title, "time": s.created_at.strftime("%H:%M")} for s in sessions])

@app.route("/chat/messages/<int:session_id>")
@login_required
def chat_messages(session_id):
    messages = ChatMessage.query.filter_by(session_id=session_id).order_by(ChatMessage.created_at).all()
    return jsonify([{"role": m.role, "content": m.content} for m in messages])

@app.route("/chat/delete/<int:session_id>", methods=["DELETE"])
@login_required
def delete_chat(session_id):
    ChatMessage.query.filter_by(session_id=session_id).delete()
    ChatSession.query.filter_by(id=session_id).delete()
    db.session.commit()
    return jsonify({"success": True})

@app.route("/api/profile")
@login_required
def api_profile():
    user = User.query.get(session['user_id'])
    return jsonify({
        "username": user.username, "email": user.email,
        "role": user.role, "created_at": user.created_at.strftime("%d %b %Y")
    })

@app.route("/api/stats")
@role_required("admin")
def api_stats():
    total_users = User.query.count()
    total_admins = User.query.filter_by(role="admin").count()
    total_chats = ChatSession.query.count()
    total_messages = ChatMessage.query.count()
    total_docs = UploadedDocument.query.count()
    chat_trend = db.session.query(func.date(ChatSession.created_at), func.count(ChatSession.id))\
        .group_by(func.date(ChatSession.created_at)).order_by(func.date(ChatSession.created_at)).all()
    message_trend = db.session.query(func.date(ChatMessage.created_at), func.count(ChatMessage.id))\
        .group_by(func.date(ChatMessage.created_at)).order_by(func.date(ChatMessage.created_at)).all()
    return jsonify({
        "total_users": total_users, "total_admins": total_admins,
        "total_chats": total_chats, "total_messages": total_messages, "documents": total_docs,
        "chat_trend": [[str(d), c] for d, c in chat_trend],
        "message_trend": [[str(d), c] for d, c in message_trend]
    })

@app.route("/notifications")
@login_required
def user_notifications():
    user_id = session['user_id']
    reqs = AdminRequest.query.filter_by(user_id=user_id).all()
    uploads = UploadedDocument.query.order_by(UploadedDocument.uploaded_at.desc()).limit(10).all()
    notifications = []
    for r in reqs:
        notifications.append({"text": f"Your admin request is {r.status.upper()}",
                               "time": r.created_at.strftime("%H:%M"), "type": "request"})
    for u in uploads:
        notifications.append({"text": f"New document uploaded: {u.filename}",
                               "time": u.uploaded_at.strftime("%H:%M"), "type": "upload"})
    return jsonify(notifications)

@app.route("/admin/analytics")
@role_required("admin")
def analytics():
    users = User.query.filter_by(role="user").count()
    admins = User.query.filter_by(role="admin").count()
    chats = ChatSession.query.count()
    messages = ChatMessage.query.count()
    docs = UploadedDocument.query.count()
    last_7_days = [(datetime.utcnow() - timedelta(days=i)).date() for i in range(6, -1, -1)]
    chat_data = db.session.query(func.date(ChatSession.created_at), func.count(ChatSession.id))\
        .group_by(func.date(ChatSession.created_at)).all()
    chat_map = {str(d): c for d, c in chat_data}
    msg_data = db.session.query(func.date(ChatMessage.created_at), func.count(ChatMessage.id))\
        .group_by(func.date(ChatMessage.created_at)).all()
    msg_map = {str(d): c for d, c in msg_data}
    return jsonify({
        "users": users, "admins": admins, "chats": chats, "messages": messages, "documents": docs,
        "chat_dates": [d.strftime("%d %b") for d in last_7_days],
        "chat_counts": [chat_map.get(str(d), 0) for d in last_7_days],
        "msg_dates": [d.strftime("%d %b") for d in last_7_days],
        "msg_counts": [msg_map.get(str(d), 0) for d in last_7_days]
    })

@app.route('/logout')
def logout():
    session.clear()
    flash('Logged out successfully!', 'success')
    return redirect(url_for('login'))

if __name__ == '__main__':
    with app.app_context():
        # db.drop_all()
        db.create_all()
    socketio.run(app, host="0.0.0.0", port=5000, debug=True)
