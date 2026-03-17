from src.helper import load_document
from flask_socketio import SocketIO, emit
import os
import certifi
import traceback
from datetime import datetime
from functools import wraps

# Fix SSL issue for HuggingFace downloads
os.environ["SSL_CERT_FILE"] = certifi.where()

from flask import Flask, render_template, jsonify, redirect, url_for, request, session, flash
from flask_sqlalchemy import SQLAlchemy
from flask_mail import Mail, Message
from itsdangerous import URLSafeTimedSerializer
from dotenv import load_dotenv
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename

from authlib.integrations.flask_client import OAuth

# LangChain + RAG
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

# Max upload size: 50 MB
MAX_UPLOAD_BYTES = 50 * 1024 * 1024

load_dotenv()

app = Flask(__name__)

socketio = SocketIO(app, cors_allowed_origins="*")
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'dev-secret-for-local-testing-2026')
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///personal_assistant.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {'pool_pre_ping': True}

# Email config
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

# ✅ BULLETPROOF SERIALIZER - Works with ALL itsdangerous versions
def get_reset_serializer():
    return URLSafeTimedSerializer(app.config['SECRET_KEY'], salt='password-reset-salt')

ALLOWED_EXTENSIONS = {'pdf','txt','xlsx','png','jpg','jpeg'}

# -------------------------
# GOOGLE OAUTH SETUP
# -------------------------

oauth = OAuth(app)

google = oauth.register(
    name='google',
    client_id=os.getenv("GOOGLE_CLIENT_ID"),
    client_secret=os.getenv("GOOGLE_CLIENT_SECRET"),
    server_metadata_url='https://accounts.google.com/.well-known/openid-configuration',
    client_kwargs={
        'scope': 'openid email profile'
    }
)

# -------------------------
# ENV KEYS
# -------------------------

PINECONE_API_KEY = os.getenv("PINECONE_API_KEY")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")

if PINECONE_API_KEY:
    os.environ["PINECONE_API_KEY"] = PINECONE_API_KEY

if GROQ_API_KEY:
    os.environ["GROQ_API_KEY"] = GROQ_API_KEY

# -------------------------
# RAG INITIALIZATION
# -------------------------

index_name = "personal-assistant"

try:
    # ✅ FIX: Initialize Pinecone client before using it
    pc = Pinecone(api_key=PINECONE_API_KEY)

    # Create index if not exists
    if index_name not in [i.name for i in pc.list_indexes()]:
        pc.create_index(
            name=index_name,
            dimension=384,
            metric="cosine",
            spec=ServerlessSpec(
                cloud="aws",
                region="us-east-1"
            )
        )

    embeddings = download_hugging_face_embeddings()

    docsearch = PineconeVectorStore.from_existing_index(
        index_name=index_name,
        embedding=embeddings
    )

    retriever = docsearch.as_retriever(search_type="similarity", search_kwargs={"k": 6})

    chatModel = ChatGroq(
        model="llama-3.1-8b-instant",
        temperature=0,
        max_tokens=512,
        groq_api_key=GROQ_API_KEY
    )

    prompt = ChatPromptTemplate.from_messages([
        ("system", system_prompt),
        ("human", "{input}")
    ])

    question_answer_chain = create_stuff_documents_chain(chatModel, prompt)
    rag_chain = create_retrieval_chain(retriever, question_answer_chain)

except Exception as e:
    print("\n===== RAG INITIALIZATION ERROR =====")
    traceback.print_exc()
    rag_chain = None


# -------------------------
# DATABASE MODELS
# -------------------------


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
    role = db.Column(db.String(20))   # user / assistant
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
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    status = db.Column(db.String(20), default="pending")
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    user = db.relationship('User', backref='admin_requests')

# -------------------------
# HELPERS
# -------------------------

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS



def login_required(f):
    from functools import wraps
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'user_id' not in session:
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated


def role_required(role):
    from functools import wraps

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

# ✅ PRODUCTION-READY EMAIL with HTML + Debug link
def send_reset_email(email, reset_url):  
    try:
        msg = Message("🔐 Password Reset", sender=app.config['MAIL_USERNAME'], recipients=[email])
        msg.html = f"<h2>Reset Password</h2><a href='{reset_url}' style='background:#3b82f6;color:white;padding:12px 24px;border-radius:8px;'>Reset Password</a>"
        msg.body = f"Reset: {reset_url}"
        
        mail.send(msg)
        return True
    except Exception as e:
        return False

# @app.route('/')
# def index():
#     return redirect(url_for('login'))

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

        # allow login using username OR email
        user = User.query.filter(
            (User.username == identifier) | (User.email == identifier)
        ).first()

        if user and user.check_password(password):


            session['user_id'] = user.id
            session['role'] = user.role

            flash('Login successful! Welcome back.', 'success')

            # ADMIN PANEL
            if user.role == 'admin':
                return redirect(url_for('admin'))

            # USER DASHBOARD
            else:
                return redirect(url_for('dashboard'))

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
                user = User(
                    username=username, 
                    email=email, 
                    password_hash=generate_password_hash(password),
                    role='user'
                )
                db.session.add(user)
                db.session.commit()
                flash(f'✅ Welcome {username}! Please login.', 'success')
                return redirect(url_for('login'))
            except Exception as e:
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
                email_sent = send_reset_email(email, reset_url)
                if email_sent:
                    flash('✅ Check your email for reset link! (Console shows link)', 'success')
                else:
                    flash('❌ Email failed. Check console for manual link.', 'error')
            except Exception as e:
                flash('Failed to send reset link. Try again.', 'error')
        else:
            flash('No account found with that email. Register first?', 'error')
    return render_template('forgot_password.html')

@app.route('/reset-password/<token>', methods=['GET', 'POST'])
def reset_password(token):
    try:
        s = get_reset_serializer()
        email = s.loads(token, max_age=3600)
    except Exception as e:
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
        except Exception as e:
            db.session.rollback()
            flash('Reset failed. Try again.', 'error')
    
    return render_template('reset_password.html', token=token)

@app.route('/dashboard')
@login_required
def dashboard():

    user_id = session['user_id']
    user = User.query.get(user_id)

    if not user:
        flash('Session expired. Please login again.', 'error')
        return redirect(url_for('login'))

    # Admin panel
    if user.role == "admin":
        return redirect(url_for('admin'))

    # Normal user panel
    return render_template('chat.html', user=user)


@app.route('/user/profile')
@login_required
def user_profile():
    """Returns the current user's profile as JSON for the chat UI."""
    user = User.query.get(session['user_id'])
    if not user:
        return jsonify({"success": False, "message": "User not found"}), 404
    return jsonify({
        "success": True,
        "user": {
            "id":       user.id,
            "username": user.username,
            "email":    user.email,
            "role":     user.role
        }
    })


# -------------------------
# GOOGLE LOGIN
# -------------------------

# -------------------------
# GOOGLE LOGIN
# -------------------------
@app.route('/login/google')
def google_login():

    redirect_uri = url_for('google_callback', _external=True)

    return google.authorize_redirect(
        redirect_uri,
        prompt="consent"
    )


@app.route('/google/callback')
def google_callback():

    token = google.authorize_access_token()

    resp = google.get('https://openidconnect.googleapis.com/v1/userinfo')
    user_info = resp.json()

    email = user_info["email"]
    username = email.split("@")[0]

    user = User.query.filter_by(email=email).first()

    if not user:

        existing_username = User.query.filter_by(username=username).first()

        if existing_username:
            username = username + str(int(datetime.utcnow().timestamp()))

        user = User(
            username=username,
            email=email,
            password_hash=generate_password_hash("oauth_user"),
            role="user"
        )

        db.session.add(user)
        db.session.commit()

    session['user_id'] = user.id
    session['role'] = user.role

    return redirect(url_for('dashboard'))

# -------------------------
# ADMIN DASHBOARD
# -------------------------

@app.route('/admin')
@role_required('admin')
def admin():

    user = User.query.get(session['user_id'])

    documents = UploadedDocument.query.order_by(
        UploadedDocument.uploaded_at.desc()
    ).all()

    return render_template(
        'admin_dashboard.html',
        user=user,
        documents=documents
    )

@app.route("/admin/request", methods=["POST"])
@login_required
def request_admin():
    user_id = session["user_id"]
    user = User.query.get(user_id)

    existing = AdminRequest.query.filter_by(user_id=user_id).first()

    if existing and existing.status == "pending":
        return jsonify({"message": "Request already pending"})
    if existing and existing.status == "approved":
        return jsonify({"message": "You are already admin"})
    if existing and existing.status == "rejected":
        existing.status = "pending"
        existing.created_at = datetime.utcnow()
    else:
        req = AdminRequest(user_id=user_id)
        db.session.add(req)

    db.session.commit()
    socketio.emit("new_notification", {
        "text": f"{user.username} requested admin access",
        "time": datetime.utcnow().strftime("%H:%M")
    })
    return jsonify({"message": "Admin request sent"})

@app.route("/admin/approve/<int:req_id>", methods=["POST"])
@role_required("admin")
def approve_request(req_id):

    req = AdminRequest.query.get(req_id)

    user = User.query.get(req.user_id)

    user.role = "admin"
    req.status = "approved"

    db.session.commit()

    return jsonify({"message": "User promoted to admin"})

@app.route("/admin/reject/<int:req_id>", methods=["POST"])
@role_required("admin")
def reject_request(req_id):

    req = AdminRequest.query.get(req_id)

    req.status = "rejected"

    db.session.commit()

    return jsonify({"message": "Request rejected"})

@app.route("/admin/notifications")
@role_required("admin")
def admin_notifications():

    requests = AdminRequest.query.order_by(
        AdminRequest.created_at.desc()
    ).all()

    uploads = UploadedDocument.query.order_by(
        UploadedDocument.uploaded_at.desc()
    ).all()

    notifications = []

    for r in requests:
        notifications.append({
            "text": f"{r.user.username} requested admin access",
            "time": r.created_at.strftime("%H:%M"),
            "type": "request"
        })

    for u in uploads:
        user = User.query.get(u.uploaded_by)

        notifications.append({
            "text": f"{user.username} uploaded {u.filename}",
            "time": u.uploaded_at.strftime("%H:%M"),
            "type": "upload"
        })

    return jsonify(notifications)

# In-memory progress store: { doc_id (int) -> progress_payload (dict) }
# Written by the background thread, read by the polling endpoint.
_upload_progress: dict = {}


def _process_document_background(app_ctx, doc_id: int, filepath: str,
                                  file_size: int, user_id: int, filename: str):
    """
    Runs in a daemon thread so the HTTP response is returned immediately.
    Emits SocketIO events so the frontend can show a live progress bar.

    KEY FIX: socketio.emit() is called with namespace='/' explicitly and
    uses the eventlet/gevent-safe emit path. A in-memory progress dict
    (_upload_progress) is also updated so the /admin/upload/status/<id>
    polling endpoint always returns the real state — this acts as a
    fallback when a SocketIO event is missed (race condition on connect).
    """
    def _emit(event: str, payload: dict):
        # Update in-memory state FIRST (polling fallback)
        _upload_progress[doc_id] = payload
        # Then push via SocketIO — use namespace='/' to avoid silent failures
        try:
            socketio.emit(event, payload, namespace="/")
        except Exception:
            pass   # emit failure must never crash the processing thread

    with app_ctx:
        try:
            # ── 1. Parse document ──────────────────────────────────────────
            _emit("upload_progress", {
                "doc_id": doc_id, "stage": "parsing",
                "pct": 5, "label": "📄 Parsing document…"
            })
            documents = load_document(filepath)
            docs      = filter_to_minimal_docs(documents)

            # ── 2. Adaptive chunking (smaller chunks for large files) ──────
            _emit("upload_progress", {
                "doc_id": doc_id, "stage": "chunking",
                "pct": 20, "label": "✂️ Splitting into chunks…"
            })
            chunks = text_split_large(docs, file_size_bytes=file_size)
            total_chunks = len(chunks)

            if docsearch is None:
                raise RuntimeError(
                    "Vector store not initialized — check PINECONE_API_KEY."
                )

            # ── 3. Parallel batch upsert to Pinecone ───────────────────────
            _emit("upload_progress", {
                "doc_id": doc_id, "stage": "indexing",
                "pct": 25, "total_chunks": total_chunks,
                "done_chunks": 0,
                "label": f"🔗 Indexing 0 / {total_chunks} chunks…"
            })

            def _progress_cb(done: int, total: int):
                pct = 25 + int((done / total) * 65)   # 25 → 90 %
                _emit("upload_progress", {
                    "doc_id":       doc_id,
                    "stage":        "indexing",
                    "pct":          pct,
                    "done_chunks":  done,
                    "total_chunks": total,
                    "label":        f"🔗 Indexing {done} / {total} chunks…"
                })

            # Choose concurrency: more threads for large docs
            workers  = 4 if total_chunks > 200 else 2
            batch_sz = 50 if total_chunks > 200 else 30

            processed = process_chunks_in_batches(
                chunks,
                batch_processor=docsearch.add_documents,
                batch_size=batch_sz,
                max_workers=workers,
                progress_callback=_progress_cb,
            )

            # ── 4. Mark completed in DB ────────────────────────────────────
            doc = UploadedDocument.query.get(doc_id)
            doc.status       = "completed"
            doc.chunks_count = processed
            db.session.commit()

            _emit("upload_progress", {
                "doc_id":  doc_id,
                "stage":   "done",
                "pct":     100,
                "label":   "✅ Done!",
                "message": f"{filename} indexed ({processed} chunks)",
                "success": True,
            })

        except Exception as exc:
            traceback.print_exc()

            try:
                doc = UploadedDocument.query.get(doc_id)
                if doc:
                    doc.status = "failed"
                    db.session.commit()
            except Exception:
                pass

            _emit("upload_progress", {
                "doc_id":  doc_id,
                "stage":   "error",
                "pct":     0,
                "label":   "❌ Processing failed",
                "message": str(exc),
                "success": False,
            })
        finally:
            # Clean up memory entry after a delay so late polls still see it
            def _cleanup():
                import time
                time.sleep(30)
                _upload_progress.pop(doc_id, None)
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

    # ── Size guard (read Content-Length header before streaming) ──────────
    content_length = request.content_length
    if content_length and content_length > MAX_UPLOAD_BYTES:
        return jsonify({
            "success": False,
            "message": f"File too large. Maximum allowed size is "
                       f"{MAX_UPLOAD_BYTES // (1024*1024)} MB."
        })

    try:
        filename  = secure_filename(file.filename)
        filepath  = os.path.join(app.config["UPLOAD_FOLDER"], filename)
        file.save(filepath)

        file_size = os.path.getsize(filepath)

        # Second size check after save (Content-Length can be absent/spoofed)
        if file_size > MAX_UPLOAD_BYTES:
            os.remove(filepath)
            return jsonify({
                "success": False,
                "message": f"File too large ({file_size // (1024*1024)} MB). "
                           f"Maximum is {MAX_UPLOAD_BYTES // (1024*1024)} MB."
            })

        user_id = session["user_id"]

        # Persist DB record immediately so the frontend can track it
        doc = UploadedDocument(
            filename          = filename,
            original_filename = file.filename,
            uploaded_by       = user_id,
            file_size         = file_size,
            status            = "processing",
        )
        db.session.add(doc)
        db.session.commit()
        doc_id = doc.id

        # ── Kick off background processing thread ─────────────────────────
        t = threading.Thread(
            target=_process_document_background,
            args=(app.app_context(), doc_id, filepath, file_size, user_id, filename),
            daemon=True,
        )
        t.start()

        # Return immediately — frontend polls via SocketIO events
        return jsonify({
            "success":  True,
            "queued":   True,
            "doc_id":   doc_id,
            "message":  f"{filename} uploaded — processing in background…",
        })

    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "message": str(e)})

@app.route("/admin/upload/status/<int:doc_id>")
@role_required("admin")
def upload_status(doc_id):
    """
    Polling fallback — returns the latest progress snapshot for a given
    doc_id.  The JS polls this every 2 s as a safety net in case a
    SocketIO event was missed (e.g. emitted before the client connected).
    Once the stage is 'done' or 'error' the DB record is the source of
    truth, so we merge both sources.
    """
    # 1. Try live in-memory snapshot first
    snapshot = _upload_progress.get(doc_id)
    if snapshot:
        return jsonify({"success": True, "progress": snapshot})

    # 2. Fall back to DB record (covers the case where the thread finished
    #    and the memory entry was already cleaned up)
    doc = UploadedDocument.query.get(doc_id)
    if not doc:
        return jsonify({"success": False, "message": "Document not found"})

    if doc.status == "completed":
        return jsonify({"success": True, "progress": {
            "doc_id":  doc_id,
            "stage":   "done",
            "pct":     100,
            "label":   "✅ Done!",
            "message": f"{doc.filename} indexed ({doc.chunks_count} chunks)",
            "success": True,
        }})

    if doc.status == "failed":
        return jsonify({"success": True, "progress": {
            "doc_id":  doc_id,
            "stage":   "error",
            "pct":     0,
            "label":   "❌ Processing failed",
            "message": "Processing failed — check server logs.",
            "success": False,
        }})

    # Still processing but no snapshot yet (thread just started)
    return jsonify({"success": True, "progress": {
        "doc_id": doc_id,
        "stage":  "parsing",
        "pct":    5,
        "label":  "📄 Parsing document…",
    }})

@app.route("/admin/documents")
@role_required("admin")
def get_documents():

    docs = UploadedDocument.query.order_by(
        UploadedDocument.uploaded_at.desc()
    ).all()

    data = []

    for d in docs:
        data.append({
            "id": d.id,
            "filename": d.filename,
            "status": d.status,
            "chunks_count": d.chunks_count,
            "file_size": d.file_size,
            "uploaded_at": d.uploaded_at.strftime("%Y-%m-%d %H:%M"),
            "uploaded_by": d.uploaded_by
        })

    return jsonify({
        "success": True,
        "documents": data
    })

@app.route("/admin/delete/<int:doc_id>", methods=["DELETE"])
@role_required("admin")
def delete_document(doc_id):

    doc = UploadedDocument.query.get(doc_id)

    if not doc:
        return jsonify({"success": False, "message": "Document not found"})

    filepath = os.path.join(app.config["UPLOAD_FOLDER"], doc.filename)

    if os.path.exists(filepath):
        os.remove(filepath)

    db.session.delete(doc)
    db.session.commit()

    return jsonify({
        "success": True,
        "message": "Document deleted successfully"
    })
    
@app.route("/admin/requests")
@role_required("admin")
def get_admin_requests():

    requests = AdminRequest.query.filter_by(status="pending").all()

    data = []

    for r in requests:
        user = User.query.get(r.user_id)

        data.append({
            "id": r.id,
            "username": user.username,
            "email": user.email
        })

    return jsonify(data)
    
# -------------------------
# CHAT
# -------------------------

@app.route("/get", methods=["POST"])
@login_required
def chat():

    msg = request.form.get("msg")
    session_id = request.form.get("session_id")

    if not rag_chain:
        return "Chat system not initialized."

    response = rag_chain.invoke({"input": msg})
    answer = str(response.get("answer"))

    # Save user message
    user_message = ChatMessage(
        session_id=session_id,
        role="user",
        content=msg
    )

    db.session.add(user_message)

   # AUTO TITLE GENERATION (ONLY FIRST MESSAGE)
    chat_session = ChatSession.query.get(session_id)

    if chat_session and chat_session.title == "New Chat":
        chat_session.title = msg[:40]   # first 40 characters

    # SAVE AI MESSAGE
    bot_message = ChatMessage(
        session_id=session_id,
        role="assistant",
        content=answer
    )

    db.session.add(bot_message)
    db.session.commit()

    return answer

@app.route("/chat/new")
@login_required
def new_chat():

    user_id = session["user_id"]

    new_session = ChatSession(
        user_id=user_id,
        title="New Chat"
    )

    db.session.add(new_session)
    db.session.commit()

    return jsonify({
        "session_id": new_session.id
    })

@app.route("/chat/history")
@login_required
def chat_history():

    user_id = session["user_id"]

    sessions = ChatSession.query.filter_by(
        user_id=user_id
    ).order_by(ChatSession.created_at.desc()).all()

    data = []

    for s in sessions:
        data.append({
            "id": s.id,
            "title": s.title,
            "time": s.created_at.strftime("%H:%M")
        })

    return jsonify(data)

@app.route("/chat/messages/<int:session_id>")
@login_required
def chat_messages(session_id):

    messages = ChatMessage.query.filter_by(
        session_id=session_id
    ).order_by(ChatMessage.created_at).all()

    data = []

    for m in messages:
        data.append({
            "role": m.role,
            "content": m.content
        })

    return jsonify(data)

@app.route("/chat/delete/<int:session_id>", methods=["DELETE"])
@login_required
def delete_chat(session_id):

    ChatMessage.query.filter_by(session_id=session_id).delete()

    ChatSession.query.filter_by(id=session_id).delete()

    db.session.commit()

    return jsonify({"success": True})


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
