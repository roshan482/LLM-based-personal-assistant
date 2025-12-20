from app import db, User
from sqlalchemy import inspect

# Check tables
inspector = inspect(db.engine)
print("Tables:", inspector.get_table_names())

# Check if User table exists
if 'user' in inspector.get_table_names():
    print("✓ User table exists!")
    
    # Check columns
    columns = inspector.get_columns('user')
    print("Columns:", [col['name'] for col in columns])
