"""
ingest.py — build the FAISS knowledge base the RAG chain reads from.

Without this, main.py falls back to an empty store and every answer will be
"I don't have enough information from the medical database...".

Usage:
    1. Put your reference material (medical notes, guidelines, .txt/.md files)
       into Backend/data/
    2. Run:  python ingest.py
    3. This writes/overwrites Backend/services/faiss_db/
"""

from pathlib import Path

from langchain_community.document_loaders import DirectoryLoader, TextLoader
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_community.vectorstores import FAISS
from langchain_text_splitters import RecursiveCharacterTextSplitter

DATA_DIR = Path(__file__).resolve().parent / "data"
FAISS_PATH = Path(__file__).resolve().parent / "services" / "faiss_db"


def main():
    DATA_DIR.mkdir(exist_ok=True)
    files = list(DATA_DIR.glob("**/*.txt")) + list(DATA_DIR.glob("**/*.md"))

    if not files:
        print(f"No .txt/.md files found in {DATA_DIR}. Add source documents and re-run.")
        return

    loader = DirectoryLoader(str(DATA_DIR), glob="**/*.[tm][xd]", loader_cls=TextLoader)
    docs = loader.load()

    splitter = RecursiveCharacterTextSplitter(chunk_size=800, chunk_overlap=120)
    chunks = splitter.split_documents(docs)

    embeddings = HuggingFaceEmbeddings(model_name="sentence-transformers/all-MiniLM-L6-v2")
    vectorstore = FAISS.from_documents(chunks, embeddings)

    FAISS_PATH.mkdir(parents=True, exist_ok=True)
    vectorstore.save_local(str(FAISS_PATH))
    print(f"Indexed {len(chunks)} chunks from {len(files)} files into {FAISS_PATH}")


if __name__ == "__main__":
    main()
