# Deploying Medico (Vercel + Render)

Two pieces, deployed separately:
- **Frontend** (`Frontend/vite-project`) → **Vercel** (static site)
- **Backend** (`Backend`) → **Render** (Python web service)

## 1. Get your API keys first
- **Hugging Face token**: https://huggingface.co/settings/tokens (needs at least "read" access; the chat model, `Qwen/Qwen2.5-7B-Instruct`, must be usable via Inference API on your account tier)
- **Google API key** (for Gemini image analysis): https://aistudio.google.com/app/apikey

## 2. Deploy the backend to Render
1. Push this repo to GitHub.
2. In Render: **New → Web Service** → connect the repo.
3. Set:
   - **Root Directory**: `Backend`
   - **Runtime**: Python 3
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `uvicorn main:app --host 0.0.0.0 --port $PORT`
   (Or just commit `render.yaml` at the repo root and use "New → Blueprint" instead — Render will read it automatically.)
4. Add environment variables in the Render dashboard:
   - `HUGGINGFACEHUB_API_TOKEN`
   - `GOOGLE_API_KEY`
   - `FRONTEND_ORIGIN` — set this **after** step 3 below, once you know your Vercel URL (e.g. `https://medico.vercel.app`). You can leave it as `http://localhost:5173` for now and update it later — CORS will just block the deployed frontend until you do.
5. Deploy. Confirm it's alive by visiting `https://<your-service>.onrender.com/health` — should return `{"status":"ok"}`.

**About the knowledge base:** the backend boots fine with an empty FAISS store, but every answer will be the generic "not enough information" fallback until you add real content. Locally, drop `.txt`/`.md` files into `Backend/data/`, run `python ingest.py`, then commit the generated `Backend/services/faiss_db/` folder (or re-run `ingest.py` as part of your build if you'd rather not commit the index).

> Free-tier Render services spin down when idle and take ~30–60s to wake on the next request — the first message after inactivity will feel slow. That's expected, not a bug.

## 3. Deploy the frontend to Vercel
1. In Vercel: **New Project** → import the same repo.
2. Set **Root Directory** to `Frontend/vite-project`.
3. Framework preset: Vite (auto-detected via `vercel.json`).
4. Add environment variable:
   - `VITE_API_BASE_URL` = `https://<your-render-service>.onrender.com`
5. Deploy.

## 4. Close the loop
Go back to Render and set `FRONTEND_ORIGIN` to your real Vercel URL (comma-separate multiple origins if needed), then trigger a redeploy so CORS allows the deployed frontend to call the API.

## 5. Local development
```bash
# Terminal 1 — backend
cd Backend
python -m venv venv && source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env   # fill in your keys
uvicorn main:app --reload --port 8000

# Terminal 2 — frontend
cd Frontend/vite-project
npm install
npm run dev
```
Leave `VITE_API_BASE_URL` empty locally — `vite.config.ts` already proxies `/api/*` to `http://localhost:8000`.

## Known limitations (by design, to keep this deployable)
- Chat has **no server-side memory** between requests — each `/api/chat` call is independent. The original scripts kept one global conversation history, which would mix different visitors' chats together on a real server.
- TTS uses gTTS (needs outbound internet from Render, which is fine) and returns MP3, not WAV.
- The FAISS index is empty until you run `ingest.py` with real source documents.
