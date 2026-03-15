from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash
from datetime import datetime
from flask import Flask, render_template, redirect, url_for, request, session, flash
from flask_mail import Mail, Message
from itsdangerous import URLSafeTimedSerializer
from dotenv import load_dotenv
import os

load_dotenv()

app = Flask(__name__)
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

db = SQLAlchemy(app)
mail = Mail(app)

# ✅ BULLETPROOF SERIALIZER - Works with ALL itsdangerous versions
def get_reset_serializer():
    return URLSafeTimedSerializer(app.config['SECRET_KEY'], salt='password-reset-salt')

class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    role = db.Column(db.String(20), default='user', nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)

def login_required(f):
    from functools import wraps
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'user_id' not in session:
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated

# ✅ PRODUCTION-READY EMAIL with HTML + Debug link
def send_reset_email(email, reset_url):
    print(f"📧 SENDING to: {email}")
    print(f"📧 Using: {app.config['MAIL_USERNAME'][:3]}...@{app.config['MAIL_SERVER']}")
    print(f"📧 Port: {app.config['MAIL_PORT']}, TLS: {app.config['MAIL_USE_TLS']}")
    
    try:
        msg = Message("🔐 Password Reset", sender=app.config['MAIL_USERNAME'], recipients=[email])
        msg.html = f"<h2>Reset Password</h2><a href='{reset_url}' style='background:#3b82f6;color:white;padding:12px 24px;border-radius:8px;'>Reset Password</a>"
        msg.body = f"Reset: {reset_url}"
        
        mail.send(msg)
        print(f"✅ EMAIL SUCCESS → {email}")
        print(f"🔗 {reset_url}")
        return True
    except Exception as e:
        print(f"❌ EMAIL FAILED: {str(e)}")
        print(f"📧 CONFIG: USER={app.config['MAIL_USERNAME'][:3]}... PORT={app.config['MAIL_PORT']}")
        return False

@app.route('/')
def index():
    return redirect(url_for('login'))

@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        identifier = request.form.get('username', '').strip()
        password = request.form.get('password')
        
        if not identifier or not password:
            flash('Please enter username/email and password!', 'error')
            return render_template('login.html')
        
        print(f"🔍 LOGIN: identifier='{identifier}'")
        
        user = User.query.filter(
            (User.username == identifier) | (User.email == identifier)
        ).first()
        
        print(f"🔍 USER FOUND: {user.username if user else 'NONE'}")
        
        if user and user.check_password(password):
            print("✅ PASSWORD OK!")
            session['user_id'] = user.id
            flash('Login successful! Welcome back.', 'success')
            return redirect(url_for('dashboard'))
        else:
            print("❌ PASSWORD FAILED!")
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
                print(f"❌ REGISTRATION ERROR: {e}")
    
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
                print(f"🔴 TOKEN ERROR: {e}")
                flash('Failed to send reset link. Try again.', 'error')
        else:
            flash('No account found with that email. Register first?', 'error')
    return render_template('forgot_password.html')

@app.route('/reset-password/<token>', methods=['GET', 'POST'])
def reset_password(token):
    try:
        s = get_reset_serializer()
        email = s.loads(token, max_age=3600)
        print(f"✅ VALID TOKEN → EMAIL: {email}")
    except Exception as e:
        print(f"🔴 TOKEN ERROR: {e}")
        flash('❌ Invalid or expired link! Request a new one.', 'error')
        return redirect(url_for('login'))
    
    user = User.query.filter_by(email=email).first()
    if not user:
        print(f"🔴 USER NOT FOUND: {email}")
        flash('User not found! Please register.', 'error')
        return redirect(url_for('login'))
    
    if request.method == 'POST':
        password = request.form.get('password', '').strip()
        confirm = request.form.get('confirm_password', '').strip()
        
        print(f"🔧 RESET REQUEST for: {user.username}")
        
        if not password or len(password) < 6:
            flash('Password must be at least 6 characters!', 'error')
            return render_template('reset_password.html', token=token)
        if password != confirm:
            flash('Passwords do not match!', 'error')
            return render_template('reset_password.html', token=token)
        
        try:
            user.password_hash = generate_password_hash(password)
            db.session.commit()
            print(f"✅ PASSWORD RESET SUCCESS: {user.username}")
            flash('🎉 Password reset successful! You can now login.', 'success')
            return redirect(url_for('login'))
        except Exception as e:
            db.session.rollback()
            flash('Reset failed. Try again.', 'error')
            print(f"❌ RESET ERROR: {e}")
    
    return render_template('reset_password.html', token=token)

@app.route('/dashboard')
@login_required
def dashboard():
    user_id = session['user_id']
    user = User.query.get(user_id)
    if not user:
        flash('Session expired. Please login again.', 'error')
        return redirect(url_for('login'))
    return render_template('chat.html', user=user)

@app.route('/logout')
def logout():
    session.clear()
    flash('Logged out successfully!', 'success')
    return redirect(url_for('login'))

@app.route('/debug-users')
def debug_users():
    users = User.query.all()
    return f"""
    <h1>👥 All Users</h1>
    <pre style="background:#1f2937;color:#f1f5f9;padding:20px;border-radius:8px;">
USERS ({len(users)}):
{chr(10).join([f"• {u.username} ({u.email}) - {u.role}" for u in users])}
    </pre>
    <a href="/">← Back to Login</a>
    """

@app.route('/test-email')
def test_email():
    try:
        msg = Message("Test Email", recipients=["test@example.com"], sender=app.config['MAIL_USERNAME'])
        msg.body = "Test successful!"
        mail.send(msg)
        return "✅ EMAIL WORKS!"
    except Exception as e:
        return f"❌ EMAIL ERROR: {str(e)}"
    


if __name__ == '__main__':
    with app.app_context():
        print("🧹 Wiping old database...")
        db.drop_all()
        db.create_all()
        
        # ✅ Create test user
        if User.query.first() is None:
            test_user = User(
                username="testuser",
                email="test@example.com",
                password_hash=generate_password_hash("test123"),
                role="user"
            )
            db.session.add(test_user)
            db.session.commit()
            print("✅ TEST USER CREATED: testuser / test123")
        else:
            print("✅ Database ready with existing users")
    
    print("\n🚀 Server ready!")
    print("📱 Login: http://127.0.0.1:5000")
    print("🔍 Debug users: http://127.0.0.1:5000/debug-users")
    print("👤 Test login: testuser / test123")
    print("-" * 60)
    
    app.run(host="0.0.0.0", port=5000, debug=True)
