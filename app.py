# imports
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash
from datetime import datetime
from flask import Flask, render_template, jsonify, redirect, url_for, request, session, flash
from src.helper import download_hugging_face_embeddings
from langchain_pinecone import PineconeVectorStore
from langchain_groq import ChatGroq
from langchain_classic.chains import create_retrieval_chain
from langchain_classic.chains.combine_documents import create_stuff_documents_chain
from langchain_core.prompts import ChatPromptTemplate
from dotenv import load_dotenv
from src.prompt import *
import os
from functools import wraps
from werkzeug.utils import secure_filename
from src.helper import load_pdf_file, filter_to_minimal_docs, text_split
import tempfile
import shutil
from authlib.integrations.flask_client import OAuth
import traceback

load_dotenv()

app = Flask(__name__)

app.config['SECRET_KEY'] = os.getenv('FLASK_SECRET_KEY', 'dev-secret-for-local')
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///personal_assistant.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['UPLOAD_FOLDER'] = 'uploads/'
app.config['MAX_CONTENT_LENGTH'] = 100 * 1024 * 1024

db = SQLAlchemy(app)

ALLOWED_EXTENSIONS = {'pdf'}
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

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

    embeddings = download_hugging_face_embeddings()

    docsearch = PineconeVectorStore.from_existing_index(
        index_name=index_name,
        embedding=embeddings
    )

    retriever = docsearch.as_retriever(search_type="similarity", search_kwargs={"k": 3})

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
    role = db.Column(db.String(20), nullable=False, default='user')
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


# -------------------------
# HELPERS
# -------------------------

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'user_id' not in session:
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated_function


def role_required(role):
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):

            if 'user_id' not in session:
                return redirect(url_for('login'))

            user = User.query.get(session['user_id'])

            if not user:
                session.clear()
                return redirect(url_for('login'))

            if user.role != role:
                return redirect(url_for('dashboard'))

            return f(*args, **kwargs)

        return decorated_function
    return decorator


# -------------------------
# ROUTES
# -------------------------

@app.route('/')
def index():
    if 'user_id' in session:
        return redirect(url_for('dashboard'))
    return redirect(url_for('login'))


@app.route('/dashboard')
@login_required
def dashboard():
    user = User.query.get(session['user_id'])
    return render_template('chat.html', user=user)


# -------------------------
# NORMAL LOGIN
# -------------------------

@app.route('/login', methods=['GET', 'POST'])
def login():

    if request.method == 'POST':

        username = request.form.get('username')
        password = request.form.get('password')

        user = User.query.filter_by(username=username).first()

        if user and user.check_password(password):
            session['user_id'] = user.id
            session['role'] = user.role
            if user.role == 'admin':
                return redirect(url_for('admin'))
            elif user.role == 'user':
                return render_template('chat.html', user=user)
        flash('Invalid username or password', 'error')
    return render_template('login.html')


@app.route('/register', methods=['GET', 'POST'])
def register():

    if request.method == 'POST':

        username = request.form.get('username')
        email = request.form.get('email')
        password = request.form.get('password')

        existing_user = User.query.filter(
            (User.username == username) | (User.email == email)
        ).first()

        if existing_user:
            flash("User already exists")
            return redirect(url_for('register'))

        hashed_password = generate_password_hash(password)

        user = User(
            username=username,
            email=email,
            password_hash=hashed_password,
            role="user"
        )

        db.session.add(user)
        db.session.commit()

        flash("Registration successful. Please login.")
        return redirect(url_for('login'))

    return render_template("register.html")
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
    return redirect(url_for('login'))


# -------------------------
# MAIN
# -------------------------

if __name__ == '__main__':

    with app.app_context():
        db.create_all()

    app.run(host="0.0.0.0", port=5000, debug=True)