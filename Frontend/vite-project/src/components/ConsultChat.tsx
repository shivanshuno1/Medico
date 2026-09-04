"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./ConsultChat.module.css";

/* ---------- types ---------- */

type Message = {
  id: string;
  role: "user" | "assistant";
  text?: string;
  imageDataUrl?: string;
  isError?: boolean;
};

type PendingImage = {
  dataUrl: string;
  base64: string;
  mimeType: string;
};

// Minimal ambient typing for the (non-standard) Web Speech API.
type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
};

const BAR_COUNT = 28;

// Vite has no server-side API routes, so calls go to a separate backend.
// Set VITE_API_BASE_URL in .env.local — e.g. http://localhost:3001 in dev.
// Left empty, requests stay relative, which works if you proxy /api to the
// backend in vite.config.ts (already set up below) or reverse-proxy it in prod.
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

export default function ConsultChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
  const [isTyping, setIsTyping] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const [composerFocused, setComposerFocused] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const barsRef = useRef<HTMLDivElement>(null);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);

  const hasContent = input.trim().length > 0 || !!pendingImage;

  /* ---------- autosize + scroll ---------- */

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 140) + "px";
  }, [input]);

  useEffect(() => {
    const el = chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, isTyping]);

  useEffect(() => {
    return () => {
      stopRecording(true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- image attach ---------- */

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string;
      const base64 = dataUrl.split(",")[1] ?? "";
      setPendingImage({ dataUrl, base64, mimeType: file.type || "image/png" });
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  }

  /* ---------- voice: real mic waveform + live speech-to-text ---------- */

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Real amplitude-driven waveform via Web Audio API.
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const audioCtx = new AudioCtx();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 128;
      source.connect(analyser);
      audioCtxRef.current = audioCtx;
      analyserRef.current = analyser;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(dataArray);
        const bars = barsRef.current?.children;
        if (bars) {
          for (let i = 0; i < bars.length; i++) {
            const v = dataArray[i % dataArray.length] / 255;
            (bars[i] as HTMLElement).style.height = `${4 + v * 20}px`;
          }
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);

      // Live transcription via the browser's built-in speech recognition,
      // when available (Chrome/Edge/Safari). No backend or API key needed.
      const SpeechRecognition =
        (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechRecognition) {
        const recognition: SpeechRecognitionLike = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = "en-US";
        recognition.onresult = (event: any) => {
          let finalTranscript = "";
          for (let i = event.resultIndex; i < event.results.length; i++) {
            finalTranscript += event.results[i][0].transcript;
          }
          setInput(finalTranscript);
        };
        recognition.onerror = () => {
          /* mic still works for the waveform even if STT fails/unsupported */
        };
        recognitionRef.current = recognition;
        recognition.start();
      }

      setRecSeconds(0);
      timerRef.current = setInterval(() => setRecSeconds((s) => s + 1), 1000);
      setIsRecording(true);
    } catch (err) {
      console.error("Microphone access failed:", err);
      alert("Couldn't access your microphone. Check your browser's site permissions.");
    }
  }

  function stopRecording(silent = false) {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
    recognitionRef.current?.stop();
    audioCtxRef.current?.close().catch(() => {});
    streamRef.current?.getTracks().forEach((t) => t.stop());

    rafRef.current = null;
    timerRef.current = null;
    recognitionRef.current = null;
    audioCtxRef.current = null;
    streamRef.current = null;

    if (!silent) setIsRecording(false);
  }

  function handleMicClick() {
    if (isRecording) {
      stopRecording();
      textareaRef.current?.focus();
    } else {
      startRecording();
    }
  }

  /* ---------- sending ---------- */

  async function handleSend() {
    const text = input.trim();
    if (!text && !pendingImage) return;
    if (isRecording) stopRecording();

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      text: text || undefined,
      imageDataUrl: pendingImage?.dataUrl,
    };
    setMessages((m) => [...m, userMsg]);

    const imageToSend = pendingImage;
    setInput("");
    setPendingImage(null);
    setIsTyping(true);

    try {
      let reply = "";

      if (imageToSend) {
        const res = await fetch(`${API_BASE}/api/analyze-image`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text || "Describe this image in detail for medical analysis.",
            imageBase64: imageToSend.base64,
            mimeType: imageToSend.mimeType,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "Image analysis failed.");
        reply = data.reply;
      } else {
        const res = await fetch(`${API_BASE}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "Chat request failed.");
        reply = data.reply;
      }

      setMessages((m) => [
        ...m,
        { id: crypto.randomUUID(), role: "assistant", text: reply },
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong.";
      setMessages((m) => [
        ...m,
        { id: crypto.randomUUID(), role: "assistant", text: msg, isError: true },
      ]);
    } finally {
      setIsTyping(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function fillComposer(text: string) {
    setInput(text);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(text.length, text.length);
      }
    });
  }

  /* ---------- text-to-speech playback ---------- */

  async function playReply(id: string, text: string) {
    if (playingId === id) {
      audioElRef.current?.pause();
      setPlayingId(null);
      return;
    }
    try {
      setPlayingId(id);
      const res = await fetch(`${API_BASE}/api/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Couldn't generate audio.");
      const mime = data.mimeType || "audio/mpeg";
      const audio = new Audio(`data:${mime};base64,${data.audioBase64}`);
      audioElRef.current = audio;
      audio.onended = () => setPlayingId(null);
      audio.play();
    } catch (err) {
      console.error(err);
      setPlayingId(null);
    }
  }

  const bars = Array.from({ length: BAR_COUNT });

  return (
    <div className={styles.root}>
      {/* SIDEBAR */}
      <aside className={styles.rail}>
        <div className={styles.railMark}>
          <svg viewBox="0 0 24 24" fill="none" stroke="#F1F4EF" strokeWidth="1.6" strokeLinecap="round">
            <path d="M2 12h4l2-7 4 14 2-9 2 5h6" />
          </svg>
        </div>
        <div className={styles.railBtns}>
          <button className={`${styles.railBtn} ${styles.active}`} title="New consult" aria-label="New consult">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <button className={styles.railBtn} title="History" aria-label="History">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 3-6.7" />
              <path d="M3 4v5h5" />
              <path d="M12 8v4l3 2" />
            </svg>
          </button>
          <button className={styles.railBtn} title="Settings" aria-label="Settings">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z" />
            </svg>
          </button>
        </div>
      </aside>

      {/* MAIN */}
      <div className={styles.main}>
        <header className={styles.header}>
          <div className={styles.headerRow}>
            <div className={styles.wordmark}>
              Consult<span className={styles.dot} />
            </div>
            <div className={styles.headerPill}>General guidance · not a diagnosis</div>
          </div>
          <div className={styles.traceWrap}>
            <svg viewBox="0 0 600 22" preserveAspectRatio="none">
              <path
                className={styles.traceLine}
                d="M0,11 C15,11 15,4 30,4 C45,4 45,18 60,18 C75,18 75,7 90,7 L120,7 C135,7 135,15 150,15 C165,15 165,2 180,2 C195,2 195,13 210,13 L600,13 C615,13 615,4 630,4 C645,4 645,18 660,18 C675,18 675,7 690,7 L720,7 C735,7 735,15 750,15 C765,15 765,2 780,2 C795,2 795,13 810,13 L1200,13"
              />
            </svg>
          </div>
        </header>

        <div className={styles.chat} ref={chatRef}>
          <div className={styles.chatInner}>
            {messages.length === 0 && (
              <div className={styles.empty}>
                <h1>What&rsquo;s going on today?</h1>
                <p>
                  Describe how you&rsquo;re feeling, upload a photo of something you&rsquo;re
                  concerned about, or just talk it through. Consult explains what it can — a
                  real clinician handles the rest.
                </p>
                <div className={styles.chips}>
                  <button
                    className={styles.chip}
                    onClick={() =>
                      fillComposer("I've had a headache behind my right eye for two days and ")
                    }
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                      <path d="M12 20v-6M12 4v2M5 12H3M21 12h-2M6.3 6.3 4.9 4.9M19.1 19.1l-1.4-1.4M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4" />
                      <circle cx="12" cy="12" r="4" />
                    </svg>
                    Describe a symptom
                  </button>
                  <button className={styles.chip} onClick={() => fileInputRef.current?.click()}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="3" />
                      <circle cx="9" cy="9" r="2" />
                      <path d="m21 15-5-5L5 21" />
                    </svg>
                    Upload a photo
                  </button>
                  <button
                    className={styles.chip}
                    onClick={() => fillComposer("What should I know about taking ")}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M10.5 20.5 3.5 13.5a5 5 0 0 1 7-7l7 7a5 5 0 0 1-7 7Z" />
                      <path d="m8.5 8.5 7 7" />
                    </svg>
                    Ask about a medication
                  </button>
                </div>
              </div>
            )}

            {messages.map((m) => (
              <div key={m.id} className={`${styles.msgRow} ${styles[m.role]}`}>
                <div className={styles.msgLabel}>
                  {m.role === "assistant" && (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M2 12h4l2-7 4 14 2-9 2 5h6" />
                    </svg>
                  )}
                  {m.role === "user" ? "You" : "Consult"}
                </div>
                {m.imageDataUrl && (
                  <div className={styles.imgThumb}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={m.imageDataUrl} alt="Uploaded" />
                  </div>
                )}
                {m.text && (
                  <div className={`${styles.bubble} ${m.isError ? styles.errorBubble : ""}`}>
                    {m.text}
                  </div>
                )}
                {m.role === "assistant" && m.text && !m.isError && (
                  <div className={styles.msgActions}>
                    <button className={styles.playBtn} onClick={() => playReply(m.id, m.text!)}>
                      {playingId === m.id ? (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <rect x="6" y="5" width="4" height="14" />
                          <rect x="14" y="5" width="4" height="14" />
                        </svg>
                      ) : (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="m5 3 14 9-14 9V3Z" />
                        </svg>
                      )}
                      {playingId === m.id ? "Stop" : "Listen"}
                    </button>
                  </div>
                )}
              </div>
            ))}

            {isTyping && (
              <div className={`${styles.msgRow} ${styles.assistant}`}>
                <div className={styles.msgLabel}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M2 12h4l2-7 4 14 2-9 2 5h6" />
                  </svg>
                  Consult
                </div>
                <div className={styles.typingRow}>
                  <svg width="46" height="14" viewBox="0 0 46 14">
                    <path
                      fill="none"
                      stroke="#2E6F5E"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      d="M0,7 C4,7 4,2 8,2 C12,2 12,12 16,12 C20,12 20,5 24,5 L46,5"
                    >
                      <animate
                        attributeName="d"
                        dur="1.1s"
                        repeatCount="indefinite"
                        values="M0,7 C4,7 4,2 8,2 C12,2 12,12 16,12 C20,12 20,5 24,5 L46,5;
                                M0,7 C4,7 4,12 8,12 C12,12 12,2 16,2 C20,2 20,9 24,9 L46,9;
                                M0,7 C4,7 4,2 8,2 C12,2 12,12 16,12 C20,12 20,5 24,5 L46,5"
                      />
                    </path>
                  </svg>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className={styles.composerWrap}>
          <div className={styles.composerInner}>
            {pendingImage && (
              <div className={styles.attachRow}>
                <div className={styles.attachChip}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={pendingImage.dataUrl} alt="" />
                  <span>Photo attached</span>
                  <button className="remove" onClick={() => setPendingImage(null)} aria-label="Remove photo">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M18 6 6 18M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
            )}

            <div className={`${styles.composer} ${composerFocused ? styles.focused : ""}`}>
              <button className={styles.iconBtn} onClick={() => fileInputRef.current?.click()} title="Add a photo" aria-label="Add a photo">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="3" />
                  <circle cx="9" cy="9" r="2" />
                  <path d="m21 15-5-5L5 21" />
                </svg>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className={styles.fileInput}
                onChange={handleFileChange}
              />

              {isRecording ? (
                <div className={styles.recordingView}>
                  <span className={styles.recDot} />
                  <div className={styles.recBars} ref={barsRef}>
                    {bars.map((_, i) => (
                      <span key={i} style={{ height: "4px" }} />
                    ))}
                  </div>
                  {input && <span className={styles.recTranscriptHint}>{input}</span>}
                  <span className={styles.recTime}>
                    {`${Math.floor(recSeconds / 60)}:${String(recSeconds % 60).padStart(2, "0")}`}
                  </span>
                </div>
              ) : (
                <textarea
                  ref={textareaRef}
                  className={styles.textarea}
                  rows={1}
                  placeholder="Describe what's going on, or ask about the photo…"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onFocus={() => setComposerFocused(true)}
                  onBlur={() => setComposerFocused(false)}
                />
              )}

              <button
                className={`${styles.iconBtn} ${isRecording ? styles.recording : ""}`}
                onClick={handleMicClick}
                title="Speak instead"
                aria-label="Speak instead"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="2" width="6" height="12" rx="3" />
                  <path d="M5 10a7 7 0 0 0 14 0" />
                  <path d="M12 19v3" />
                </svg>
              </button>

              <button
                className={`${styles.sendBtn} ${hasContent ? styles.active : ""}`}
                onClick={handleSend}
                disabled={!hasContent || isTyping}
                title="Send"
                aria-label="Send"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m5 12 14-7-7 14-2-5-5-2Z" />
                </svg>
              </button>
            </div>

            <div className={styles.disclaimer}>
              Consult gives general information, not a diagnosis. For anything urgent, contact a
              clinician or emergency services.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}