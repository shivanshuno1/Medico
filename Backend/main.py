"""
main.py — Medico backend API (FastAPI)

This replaces the old terminal-only scripts in Backend/services/ with a real
HTTP API that the React frontend (ConsultChat.tsx) can call:

    POST /api/chat            {"message": "..."}                -> {"reply": "..."}
    POST /api/analyze-image   {"message", "imageBase64",
                                "mimeType"}                      -> {"reply": "..."}
    POST /api/tts             {"text": "..."}                    -> {"audioBase64": "..."}
    GET  /health                                                 -> {"status": "ok"}

Design notes / simplifications made on purpose for a safe first deployment:
- Chat is STATELESS (no server-side conversation memory). The original
  scripts kept one global `chat_history` list — that's fine for a single
  person typing in a terminal, but on a real server with multiple visitors
  it would mix everyone's conversations together. If you want multi-turn
  memory, have the frontend send the prior turns and thread them into the
  `chat_history` list built in `build_history()` below.
- Text-to-speech uses gTTS (Google Text-to-Speech), which calls out to
  Google and returns real MP3 bytes — unlike pyttsx3, which only plays
  audio through local speakers and cannot run on a headless server.
- If FAISS index files aren't present, a tiny fallback vector store is
  created automatically (same behavior as the original scripts) so the
  server still boots; RAG answers will just say there's no context yet
  until you run `ingest.py` with real documents.
"""

import base64
import io
import os
import warnings
from pathlib import Path

warnings.filterwarnings(
    "ignore",
    category=DeprecationWarning,
    module=r"langchain(?:_community)?",
)

from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from langchain_huggingface import (
    HuggingFaceEndpoint,
    ChatHuggingFace,
    HuggingFaceEmbeddings,
)
from langchain_community.vectorstores import FAISS
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.output_parsers import StrOutputParser
from langchain_core.messages import HumanMessage, AIMessage

from PIL import Image
import google.generativeai as genai
from gtts import gTTS

# ----------------------------------------------------
# 1. CONFIG / API KEYS (set these as env vars on Render)
# ----------------------------------------------------
HUGGINGFACEHUB_API_TOKEN = os.getenv("HUGGINGFACEHUB_API_TOKEN", "")
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY", "")
# Comma-separated list of allowed frontend origins, e.g.
# "https://medico.vercel.app,http://localhost:5173"
FRONTEND_ORIGINS = [
    o.strip() for o in os.getenv("FRONTEND_ORIGIN", "http://localhost:5173").split(",")
    if o.strip()
]

if not HUGGINGFACEHUB_API_TOKEN:
    print("WARNING: HUGGINGFACEHUB_API_TOKEN is not set — chat calls will fail.")
if not GOOGLE_API_KEY:
    print("WARNING: GOOGLE_API_KEY is not set — image analysis will fail.")
else:
    genai.configure(api_key=GOOGLE_API_KEY)

# ----------------------------------------------------
# 2. LLM + EMBEDDINGS + FAISS (loaded once at startup)
# ----------------------------------------------------
llm = HuggingFaceEndpoint(
    repo_id="Qwen/Qwen2.5-7B-Instruct",
    task="text-generation",
    max_new_tokens=256,
    temperature=0.1,
    do_sample=True,
    repetition_penalty=1.1,
    huggingfacehub_api_token=HUGGINGFACEHUB_API_TOKEN,
)
chat_model = ChatHuggingFace(llm=llm)

embeddings = HuggingFaceEmbeddings(model_name="sentence-transformers/all-MiniLM-L6-v2")

FAISS_PATH = Path(__file__).resolve().parent / "services" / "faiss_db"
INDEX_FILE = FAISS_PATH / "index.faiss"

if not FAISS_PATH.exists() or not INDEX_FILE.exists():
    FAISS_PATH.mkdir(parents=True, exist_ok=True)
    vectorstore = FAISS.from_texts(
        ["No medical context is currently available. Please add documents to the FAISS database."],
        embeddings,
    )
    vectorstore.save_local(str(FAISS_PATH))
    print(f"No FAISS index found — created an empty fallback store at {FAISS_PATH}.")
else:
    vectorstore = FAISS.load_local(
        str(FAISS_PATH), embeddings, allow_dangerous_deserialization=True
    )

retriever = vectorstore.as_retriever(search_kwargs={"k": 3})

# ----------------------------------------------------
# 3. PROMPT + RAG CHAIN
# ----------------------------------------------------
SYSTEM_PROMPT = """You are a professional medical assistant.

Answer ONLY using the supplied medical context.

If the answer cannot be found in the context, say:

"I don't have enough information from the medical database to answer this safely. Please consult a licensed healthcare professional."

Medical Context:
{context}
"""

prompt = ChatPromptTemplate.from_messages(
    [
        ("system", SYSTEM_PROMPT),
        MessagesPlaceholder(variable_name="chat_history"),
        ("human", "{question}"),
    ]
)


def format_docs(docs) -> str:
    if not docs:
        return "No relevant context found."
    return "\n\n".join(doc.page_content for doc in docs)


rag_chain = (
    {
        "context": (lambda x: x["question"]) | retriever | format_docs,
        "question": lambda x: x["question"],
        "chat_history": lambda x: x["chat_history"],
    }
    | prompt
    | chat_model
    | StrOutputParser()
)


def build_history(pairs: list[dict] | None) -> list:
    """Optional: turn [{'role': 'user'|'assistant', 'text': '...'}] from the
    client into LangChain message objects. The current frontend doesn't send
    this yet, so it's just an empty list by default."""
    history: list = []
    for pair in pairs or []:
        if pair.get("role") == "user":
            history.append(HumanMessage(content=pair.get("text", "")))
        elif pair.get("role") == "assistant":
            history.append(AIMessage(content=pair.get("text", "")))
    return history[-12:]  # keep last 6 turns


# ----------------------------------------------------
# 4. GEMINI VISION HELPER
# ----------------------------------------------------
VISION_MODEL = "gemini-2.5-flash"


def image_to_text(image_bytes: bytes, prompt_text: str) -> str:
    if not GOOGLE_API_KEY:
        raise RuntimeError("GOOGLE_API_KEY is not configured on the server.")
    model = genai.GenerativeModel(
        VISION_MODEL,
        system_instruction=(
            "You are assisting a medical assistant. Describe exactly what is shown "
            "in the image. If it contains printed or handwritten text (e.g. a "
            "prescription, label, or report), transcribe that text accurately. "
            "If it shows a visual symptom (e.g. skin condition, wound, rash), "
            "describe its visual characteristics factually and neutrally."
        ),
    )
    img = Image.open(io.BytesIO(image_bytes))
    response = model.generate_content([prompt_text, img])
    return response.text.strip()


# ----------------------------------------------------
# 5. FASTAPI APP
# ----------------------------------------------------
app = FastAPI(title="Medico API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=FRONTEND_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    message: str
    history: list[dict] | None = None


class ImageRequest(BaseModel):
    message: str | None = None
    imageBase64: str
    mimeType: str = "image/png"


class TTSRequest(BaseModel):
    text: str


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/api/chat")
def chat(req: ChatRequest):
    if not req.message or not req.message.strip():
        raise HTTPException(status_code=400, detail="message is required.")
    try:
        reply = rag_chain.invoke(
            {"question": req.message, "chat_history": build_history(req.history)}
        )
        return {"reply": reply}
    except Exception as exc:  # surfaced to the frontend's error bubble
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/analyze-image")
def analyze_image(req: ImageRequest):
    if not req.imageBase64:
        raise HTTPException(status_code=400, detail="imageBase64 is required.")
    try:
        image_bytes = base64.b64decode(req.imageBase64)
        question_text = image_to_text(
            image_bytes,
            req.message or "Describe this image in detail for medical analysis.",
        )
        reply = rag_chain.invoke(
            {"question": question_text, "chat_history": []}
        )
        return {"reply": reply}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/tts")
def tts(req: TTSRequest):
    if not req.text or not req.text.strip():
        raise HTTPException(status_code=400, detail="text is required.")
    try:
        buf = io.BytesIO()
        gTTS(text=req.text, lang="en").write_to_fp(buf)
        audio_b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
        # gTTS produces MP3, not WAV — the frontend audio tag is format-agnostic
        # as long as the data URL's mime type matches (see ConsultChat.tsx fix).
        return {"audioBase64": audio_b64, "mimeType": "audio/mpeg"}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=int(os.getenv("PORT", 8000)), reload=True)
