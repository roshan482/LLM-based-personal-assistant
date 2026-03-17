from app import app, db, User
from werkzeug.security import generate_password_hash

with app.app_context():

    username = "admin"
    email = "admin@gmail.com"
    password = "admin123"

    existing = User.query.filter_by(username=username).first()

    if existing:
        print("Admin already exists")

    else:

        admin = User(
            username=username,
            email=email,
            password_hash=generate_password_hash(password),
            role="admin"
        )

        db.session.add(admin)
        db.session.commit()

        print("✅ Admin created successfully!")