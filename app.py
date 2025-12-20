# imports
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash
from flask.cli import with_appcontext
import click
from datetime import datetime
from flask import Flask, render_template, jsonify, redirect, url_for, request
from src.helper import download_hugging_face_embeddings
from langchain_pinecone import PineconeVectorStore
from langchain_groq import ChatGroq  # Changed from Google to Groq
from langchain.chains import create_retrieval_chain
from langchain.chains.combine_documents import create_stuff_documents_chain
from langchain_core.prompts import ChatPromptTemplate
from dotenv import load_dotenv
from src.prompt import *
import os
from functools import wraps
from flask import session, flash
from werkzeug.utils import secure_filename
from src.helper import load_pdf_file, filter_to_minimal_docs, text_split
from pinecone import Pinecone
import tempfile
import shutil

app = Flask(__name__)
# You may want to move secret into env for production
app.config['SECRET_KEY'] = os.getenv('FLASK_SECRET_KEY', 'dev-secret-for-local')
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///personal_assistant.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
# Add after app configuration
app.config['UPLOAD_FOLDER'] = 'uploads/'
app.config['MAX_CONTENT_LENGTH'] = 100 * 1024 * 1024  # 25MB max file size

db = SQLAlchemy(app)

ALLOWED_EXTENSIONS = {'pdf'}

# Create upload folder if it doesn't exist
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


load_dotenv()
PINECONE_API_KEY = os.getenv("PINECONE_API_KEY")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")  # Changed from GEMINI to GROQ

if PINECONE_API_KEY:
    os.environ["PINECONE_API_KEY"] = PINECONE_API_KEY
if GROQ_API_KEY:
    os.environ["GROQ_API_KEY"] = GROQ_API_KEY

# Initialize LangChain components with Groq
index_name = "personal-assistant"
try:
    embeddings = download_hugging_face_embeddings()
    docsearch = PineconeVectorStore.from_existing_index(
        index_name=index_name,
        embedding=embeddings
    )
    retriever = docsearch.as_retriever(search_type="similarity", search_kwargs={"k": 3})
    
    # Initialize Groq Chat Model
    chatModel = ChatGroq(
        model="llama-3.1-8b-instant",  # Fast and accurate for RAG
        temperature=0,  # Deterministic responses
        max_tokens=512,  # Adjust based on your needs
        groq_api_key=GROQ_API_KEY
    )
    
    prompt = ChatPromptTemplate.from_messages([
        ("system", system_prompt),
        ("human", "{input}"),
    ])
    
    question_answer_chain = create_stuff_documents_chain(chatModel, prompt)
    rag_chain = create_retrieval_chain(retriever, question_answer_chain)
    
except Exception as e:
    print("Warning: failed to initialize vector/LLM components:", e)
    retriever = None
    chatModel = None
    rag_chain = None

# User model: make 'user' the default role
class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    role = db.Column(db.String(20), nullable=False, default='user')  # default here
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)
    
class UploadedDocument(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    filename = db.Column(db.String(255), nullable=False)
    original_filename = db.Column(db.String(255), nullable=False)
    uploaded_by = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    uploaded_at = db.Column(db.DateTime, default=datetime.utcnow)
    file_size = db.Column(db.Integer)  # in bytes
    chunks_count = db.Column(db.Integer)  # number of text chunks created
    status = db.Column(db.String(20), default='processing')  # processing, completed, failed
    
    user = db.relationship('User', backref='uploaded_documents')


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
                flash('User not found. Please login again.', 'error')
                session.clear()
                return redirect(url_for('login'))
            if user.role != role:
                flash('Access denied. Insufficient permissions.', 'error')
                return redirect(url_for('dashboard'))
            return f(*args, **kwargs)
        return decorated_function
    return decorator

@app.route('/')
def index():
    if 'user_id' in session:
        return redirect(url_for('dashboard'))
    return redirect(url_for('login'))

# Make the user-facing dashboard the default
@app.route('/dashboard')
@login_required
def dashboard():
    user = User.query.get(session['user_id'])
    if not user:
        session.clear()
        return redirect(url_for('login'))
    return render_template('chat.html', user=user)


# Update login redirect behavior
@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        password = request.form.get('password', '')
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


# Admin-only dashboard
@app.route('/admin')
@role_required('admin')
def admin():
    user = User.query.get(session['user_id'])
    documents = UploadedDocument.query.order_by(UploadedDocument.uploaded_at.desc()).all()
    return render_template('admin_dashboard.html', user=user, documents=documents)


@app.route('/admin/upload', methods=['POST'])
@role_required('admin')
def upload_pdf():
    try:
        if 'file' not in request.files:
            return jsonify({'success': False, 'message': 'No file part'}), 400
        
        file = request.files['file']
        
        if file.filename == '':
            return jsonify({'success': False, 'message': 'No selected file'}), 400
        
        if file and allowed_file(file.filename):
            filename = secure_filename(file.filename)
            timestamp = datetime.utcnow().strftime('%Y%m%d_%H%M%S')
            unique_filename = f"{timestamp}_{filename}"
            
            # Use absolute path
            upload_folder = app.config['UPLOAD_FOLDER']
            filepath = os.path.join(upload_folder, unique_filename)
            
            # Save the file
            file.save(filepath)
            file_size = os.path.getsize(filepath)
            
            # Create database record
            doc = UploadedDocument(
                filename=unique_filename,
                original_filename=filename,
                uploaded_by=session['user_id'],
                file_size=file_size,
                status='processing'
            )
            db.session.add(doc)
            db.session.commit()
            
            # Process PDF and add to vector database
            try:
                # Create a temporary directory for processing
                temp_dir = tempfile.mkdtemp()
                temp_file = os.path.join(temp_dir, unique_filename)
                shutil.copy(filepath, temp_file)
                
                # Load and process the PDF
                from langchain_community.document_loaders import PyPDFLoader
                loader = PyPDFLoader(filepath)
                extracted_data = loader.load()
                
                # Process the data
                filter_data = filter_to_minimal_docs(extracted_data)
                text_chunks = text_split(filter_data)
                
                # Add to Pinecone
                docsearch1 = PineconeVectorStore.from_documents(
                    documents=text_chunks,
                    index_name=index_name,
                    embedding=embeddings, 
                )
                
                # Clean up temp directory
                shutil.rmtree(temp_dir)
                
                # Update document record
                doc.chunks_count = len(text_chunks)
                doc.status = 'completed'
                db.session.commit()
                
                return jsonify({
                    'success': True, 
                    'message': f'File uploaded successfully! {len(text_chunks)} chunks added to knowledge base.',
                    'document_id': doc.id,
                    'chunks_count': len(text_chunks)
                }), 200
                
            except Exception as e:
                doc.status = 'failed'
                db.session.commit()
                return jsonify({'success': False, 'message': f'Error processing PDF: {str(e)}'}), 500
        
        return jsonify({'success': False, 'message': 'Invalid file type. Only PDF files are allowed.'}), 400
        
    except Exception as e:
        return jsonify({'success': False, 'message': f'Upload error: {str(e)}'}), 500


@app.route('/admin/documents', methods=['GET'])
@role_required('admin')
def get_documents():
    documents = UploadedDocument.query.order_by(UploadedDocument.uploaded_at.desc()).all()
    docs_list = [{
        'id': doc.id,
        'filename': doc.original_filename,
        'uploaded_at': doc.uploaded_at.strftime('%Y-%m-%d %H:%M:%S'),
        'file_size': f"{doc.file_size / 1024:.2f} KB" if doc.file_size else 'N/A',
        'chunks_count': doc.chunks_count,
        'status': doc.status,
        'uploaded_by': doc.user.username
    } for doc in documents]
    
    return jsonify({'success': True, 'documents': docs_list})


@app.route('/admin/delete/<int:doc_id>', methods=['DELETE'])
@role_required('admin')
def delete_document(doc_id):
    try:
        doc = UploadedDocument.query.get(doc_id)
        if not doc:
            return jsonify({'success': False, 'message': 'Document not found'}), 404
        
        # Delete physical file
        filepath = os.path.join(app.config['UPLOAD_FOLDER'], doc.filename)
        if os.path.exists(filepath):
            os.remove(filepath)
        
        # Delete database record
        db.session.delete(doc)
        db.session.commit()
        
        return jsonify({'success': True, 'message': 'Document deleted successfully'}), 200
        
    except Exception as e:
        return jsonify({'success': False, 'message': f'Delete error: {str(e)}'}), 500


@app.route('/register', methods=['GET', 'POST'])
def register():
    if request.method == 'POST':
        username = request.form['username'].strip()
        email = request.form['email'].strip()
        password = request.form['password']

        if not username or not email or not password:
            flash('Please fill all fields', 'error')
            return render_template('register.html')

        if User.query.filter_by(username=username).first():
            flash('Username already exists', 'error')
            return render_template('register.html')

        if User.query.filter_by(email=email).first():
            flash('Email already exists', 'error')
            return render_template('register.html')

        user = User(
            username=username,
            email=email,
            password_hash=generate_password_hash(password),
            role='user',
        )
        db.session.add(user)
        db.session.commit()
        flash('Registration successful! Please login.', 'success')
        return redirect(url_for('login'))

    return render_template('register.html')

@app.route('/logout')
def logout():
    session.clear()
    flash('You have been logged out.', 'info')
    return redirect(url_for('login'))


@app.route("/get", methods=["GET", "POST"])
@login_required
def chat():
    """
    Enhanced chat endpoint with error handling for Groq
    """
    try:
        if not rag_chain:
            return jsonify({
                'error': 'Chat system is not initialized. Please contact administrator.'
            }), 500
        
        msg = request.form.get("msg", "").strip()
        
        if not msg:
            return "Please provide a message."
        
        # Query the RAG chain
        response = rag_chain.invoke({"input": msg})
        
        # Return the answer
        return str(response.get("answer", "I couldn't generate a response. Please try again."))
        
    except Exception as e:
        print(f"Chat error: {str(e)}")
        return f"Sorry, I encountered an error: {str(e)}"

# CLI command to initialize database
# @click.command('init-db')
# @with_appcontext
# def init_db_command():
#     """Clear existing data and create new tables."""
#     db.create_all()
#     print('Initialized the database.')

# app.cli.add_command(init_db_command)

if __name__ == '__main__':
    app.run(host="0.0.0.0", port=8080, debug=True)