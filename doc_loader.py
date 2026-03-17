import os
import pandas as pd
import pytesseract
from PIL import Image

from langchain_core.documents import Document
from langchain_community.document_loaders import PyPDFLoader, TextLoader

# Windows tesseract path
pytesseract.pytesseract.tesseract_cmd = r"C:\Program Files\Tesseract-OCR\tesseract.exe"


def load_document(filepath):

    ext = os.path.splitext(filepath)[1].lower()

    # ======================
    # PDF
    # ======================
    if ext == ".pdf":
        loader = PyPDFLoader(filepath)
        docs = loader.load()
        return docs

    # ======================
    # TXT
    # ======================
    elif ext == ".txt":
        loader = TextLoader(filepath)
        docs = loader.load()
        return docs

    # ======================
    # XLSX
    # ======================
    elif ext == ".xlsx":

        df = pd.read_excel(filepath)

        text = ""

        for col in df.columns:
            text += " ".join(df[col].astype(str))

        docs = [Document(page_content=text, metadata={"source": filepath})]

        return docs

    # ======================
    # IMAGE OCR
    # ======================
    elif ext in [".png", ".jpg", ".jpeg"]:

        img = Image.open(filepath)

        text = pytesseract.image_to_string(img)

        docs = [Document(page_content=text, metadata={"source": filepath})]

        return docs

    else:
        raise ValueError("Unsupported file format")