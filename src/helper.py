import os
import io
import sys
import math
import pandas as pd
import threading
from PIL import Image
from typing import List, Callable, Optional
from concurrent.futures import ThreadPoolExecutor, as_completed

from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_core.documents import Document
from langchain_community.document_loaders import PyPDFLoader
from langchain_huggingface import HuggingFaceEmbeddings


# ---------------------------------------------------------
# TESSERACT SETUP  (optional — graceful if not installed)
# ---------------------------------------------------------

def _setup_tesseract() -> bool:
    """
    Try to configure pytesseract. Returns True if Tesseract is available,
    False otherwise (all OCR features are silently skipped).

    On Windows, auto-detects the default UB-Mannheim installer path so
    users don't need to manually add Tesseract to PATH.
    """
    try:
        import pytesseract

        if sys.platform == "win32":
            candidate_paths = [
                r"C:\Program Files\Tesseract-OCR\tesseract.exe",
                r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
                os.path.join(
                    os.environ.get("LOCALAPPDATA", ""),
                    "Tesseract-OCR", "tesseract.exe"
                ),
            ]
            for path in candidate_paths:
                if os.path.isfile(path):
                    pytesseract.pytesseract.tesseract_cmd = path
                    print(f"[helper] Tesseract found at: {path}")
                    break

        # Smoke-test — raises TesseractNotFoundError if missing
        pytesseract.get_tesseract_version()
        print("[helper] Tesseract OCR is available.")
        return True

    except Exception as e:
        print(f"[helper] Tesseract not available ({e}). "
              "Image OCR and scanned-PDF support disabled. "
              "Install from https://github.com/UB-Mannheim/tesseract/wiki to enable.")
        return False


_TESSERACT_AVAILABLE = _setup_tesseract()


def _ocr_image(img: Image.Image) -> str:
    """Run OCR on a PIL Image. Returns '' if Tesseract is not installed."""
    if not _TESSERACT_AVAILABLE:
        return ""
    import pytesseract
    try:
        return pytesseract.image_to_string(img)
    except Exception:
        return ""


# ---------------------------------------------------------
# INTERNAL HELPERS
# ---------------------------------------------------------

def _is_meaningful(text: str, min_chars: int = 20) -> bool:
    """True if text has enough real content to be worth indexing."""
    if not text:
        return False
    return len(" ".join(text.split())) >= min_chars


def _ocr_pdf_pages(file_path: str) -> List[Document]:
    """
    OCR fallback for scanned / image-only PDFs.
    Uses pdf2image to render each page then pytesseract to read it.
    Returns [] gracefully if pdf2image, Poppler, or Tesseract is missing.
    """
    if not _TESSERACT_AVAILABLE:
        return []

    try:
        from pdf2image import convert_from_path
    except ImportError:
        print("[helper] pdf2image not installed — skipping OCR fallback.")
        return []

    docs = []
    try:
        images = convert_from_path(file_path, dpi=200)
        for i, img in enumerate(images):
            text = _ocr_image(img)
            if _is_meaningful(text):
                docs.append(Document(
                    page_content=text,
                    metadata={"source": file_path, "page": i}
                ))
    except Exception as e:
        print(f"[helper] OCR fallback failed: {e}")

    return docs


# ---------------------------------------------------------
# UNIVERSAL FILE LOADER
# ---------------------------------------------------------

def load_document(file_path: str) -> List[Document]:
    """
    Load any supported file into LangChain Documents.

    Supported: .pdf  .txt  .xlsx  .png  .jpg  .jpeg

    PDF strategy:
      1. PyPDFLoader  — fast, works for text-based PDFs.
      2. Filter pages with < 20 real characters.
      3. If nothing survives (scanned PDF) AND Tesseract is installed,
         fall back to pdf2image + pytesseract OCR.

    Raises ValueError with a clear human-readable message on failure.
    """
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"File not found: {file_path}")

    ext = os.path.splitext(file_path)[1].lower()

    # ------------------------------------------------------------------ PDF
    if ext == ".pdf":
        loader    = PyPDFLoader(file_path)
        raw_pages = loader.load()

        # Keep only pages with real text content
        docs = [
            Document(
                page_content=p.page_content,
                metadata={"source": file_path, "page": p.metadata.get("page", i)}
            )
            for i, p in enumerate(raw_pages)
            if _is_meaningful(p.page_content)
        ]

        # Nothing extracted → try OCR if available
        if not docs:
            print(f"[helper] PyPDF found no text in '{file_path}'. Trying OCR…")
            docs = _ocr_pdf_pages(file_path)

        if not docs:
            # Give a helpful error based on whether OCR is available
            if _TESSERACT_AVAILABLE:
                raise ValueError(
                    f"No text could be extracted from '{os.path.basename(file_path)}' "
                    "even after OCR. The file may be corrupted or password-protected."
                )
            else:
                raise ValueError(
                    f"No text could be extracted from '{os.path.basename(file_path)}'. "
                    "This appears to be a scanned / image-only PDF. "
                    "To enable OCR: install Tesseract from "
                    "https://github.com/UB-Mannheim/tesseract/wiki "
                    "and restart the server."
                )

        return docs

    # ------------------------------------------------------------------ TXT
    elif ext == ".txt":
        # Try common encodings — covers UTF-8, UTF-8 BOM, and Windows files
        for encoding in ("utf-8", "utf-8-sig", "latin-1", "cp1252"):
            try:
                with open(file_path, "r", encoding=encoding) as f:
                    text = f.read()
                break
            except UnicodeDecodeError:
                continue
        else:
            raise ValueError(
                f"Cannot decode '{os.path.basename(file_path)}'. "
                "Please save it as UTF-8 and re-upload."
            )

        if not _is_meaningful(text):
            raise ValueError(f"'{os.path.basename(file_path)}' appears to be empty.")

        return [Document(page_content=text, metadata={"source": file_path})]

    # ----------------------------------------------------------------- XLSX
    elif ext == ".xlsx":
        xl   = pd.ExcelFile(file_path)
        docs = []

        for sheet in xl.sheet_names:
            df   = xl.parse(sheet)
            df   = df.dropna(how="all").dropna(axis=1, how="all")
            text = df.to_string(index=False)

            if _is_meaningful(text):
                docs.append(Document(
                    page_content=f"[Sheet: {sheet}]\n{text}",
                    metadata={"source": file_path, "sheet": sheet}
                ))

        if not docs:
            raise ValueError(
                f"'{os.path.basename(file_path)}' has no readable data in any sheet."
            )

        return docs

    # --------------------------------------------------------------- IMAGES
    elif ext in (".png", ".jpg", ".jpeg"):
        if not _TESSERACT_AVAILABLE:
            raise ValueError(
                f"Cannot process image '{os.path.basename(file_path)}': "
                "Tesseract OCR is not installed. "
                "Install it from https://github.com/UB-Mannheim/tesseract/wiki "
                "and restart the server."
            )

        image = Image.open(file_path)
        text  = _ocr_image(image)

        if not _is_meaningful(text):
            raise ValueError(
                f"No text extracted from '{os.path.basename(file_path)}'. "
                "Ensure the image contains readable printed text."
            )

        return [Document(page_content=text, metadata={"source": file_path})]

    else:
        raise ValueError(
            f"Unsupported file type '{ext}'. "
            "Allowed: .pdf  .txt  .xlsx  .png  .jpg  .jpeg"
        )


# ---------------------------------------------------------
# FILTER DOCUMENT METADATA
# ---------------------------------------------------------

def filter_to_minimal_docs(docs: List[Document]) -> List[Document]:
    """Strip metadata to just 'source' and drop any empty-content docs."""
    return [
        Document(
            page_content=doc.page_content,
            metadata={"source": doc.metadata.get("source")}
        )
        for doc in docs
        if _is_meaningful(doc.page_content)
    ]


# ---------------------------------------------------------
# TEXT CHUNKING  (original — kept for compatibility)
# ---------------------------------------------------------

def text_split(extracted_data: List[Document]) -> List[Document]:
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=1000,
        chunk_overlap=150,
    )
    return splitter.split_documents(extracted_data)


# ---------------------------------------------------------
# LARGE-FILE AWARE TEXT SPLITTING
# ---------------------------------------------------------

def text_split_large(extracted_data: List[Document],
                     file_size_bytes: int = 0) -> List[Document]:
    """
    Adaptive chunk size based on file size so individual Pinecone payloads
    stay under the 4 MB per-request limit.
    Also post-filters any chunks that became pure whitespace after splitting.
    """
    mb = file_size_bytes / (1024 * 1024)

    if mb > 20:
        chunk_size, overlap = 600, 100
    elif mb > 5:
        chunk_size, overlap = 800, 120
    else:
        chunk_size, overlap = 1000, 150

    splitter = RecursiveCharacterTextSplitter(
        chunk_size=chunk_size,
        chunk_overlap=overlap,
    )

    raw_chunks = splitter.split_documents(extracted_data)
    return [c for c in raw_chunks if _is_meaningful(c.page_content)]


# ---------------------------------------------------------
# EMBEDDINGS
# ---------------------------------------------------------

def download_hugging_face_embeddings() -> HuggingFaceEmbeddings:
    return HuggingFaceEmbeddings(
        model_name="sentence-transformers/all-MiniLM-L6-v2"
    )   # 384 dimensions


# ---------------------------------------------------------
# PARALLEL CHUNK PROCESSING
# ---------------------------------------------------------

def process_chunks_in_batches(
    chunks,
    batch_processor,
    batch_size=50,
    max_workers=1,   # FORCE SINGLE THREAD
    progress_callback=None,
):
    """
    SAFE VERSION (NO MULTITHREADING)
    HuggingFace embeddings are NOT thread-safe.
    """

    if not chunks:
        return 0

    total = len(chunks)
    done = 0

    for i in range(0, total, batch_size):
        batch = chunks[i:i + batch_size]

        # Process sequentially (NO THREADS)
        batch_processor(batch)

        done += len(batch)

        if progress_callback:
            progress_callback(done, total)

    return done
