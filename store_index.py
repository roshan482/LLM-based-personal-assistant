from dotenv import load_dotenv
import os
import certifi

os.environ["SSL_CERT_FILE"] = certifi.where()
from src.helper import (
    load_document,
    filter_to_minimal_docs,
    text_split,
    download_hugging_face_embeddings,
)
from pinecone import Pinecone, ServerlessSpec
from langchain_pinecone import PineconeVectorStore

load_dotenv()

# ==============================
# ENV VARIABLES
# ==============================
PINECONE_API_KEY = os.environ.get("PINECONE_API_KEY")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY")

os.environ["PINECONE_API_KEY"] = PINECONE_API_KEY
os.environ["GROQ_API_KEY"] = GROQ_API_KEY

# ==============================
# LOAD + PROCESS DATA
# ==============================
extracted_data = load_document("C:\\diploma_fy_project\\LLM-based-personal-assistant\\data\\Software Testing Techniques.pdf")
filter_data = filter_to_minimal_docs(extracted_data)
text_chunks = text_split(filter_data)

# ==============================
# EMBEDDINGS
# ==============================
embeddings = download_hugging_face_embeddings()

# ==============================
# PINECONE INIT
# ==============================
pc = Pinecone(api_key=PINECONE_API_KEY)

index_name = "personal-assistant"

# ==============================
# CREATE INDEX IF NOT EXISTS
# ==============================
if index_name not in pc.list_indexes().names():
    print("🚀 Creating new index...")

    pc.create_index(
        name=index_name,
        dimension=384,   # must match your embedding model
        metric="cosine",
        spec=ServerlessSpec(
            cloud="aws",
            region="us-east-1"
        ),
    )
else:
    print("✅ Index already exists")

# ==============================
# CONNECT INDEX
# ==============================
index = pc.Index(index_name)

# ==============================
# CHECK IF INDEX IS EMPTY
# ==============================
index_stats = index.describe_index_stats()

if index_stats["total_vector_count"] == 0:
    print("📥 Inserting documents into Pinecone...")

    vectorstore = PineconeVectorStore.from_documents(
        documents=text_chunks,
        embedding=embeddings,
        index_name=index_name,
    )

    print("✅ Data inserted successfully!")

else:
    print("⚡ Data already exists in index. Skipping insert.")

# ==============================
# LOAD VECTORSTORE FOR USAGE
# ==============================
docsearch = PineconeVectorStore(
    index=index,
    embedding=embeddings
)

print("🎯 Ready to use vector store!")