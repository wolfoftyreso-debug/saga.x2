"use client";

import { useEffect, useId, useRef, useState } from "react";

type ListenerState = "idle" | "loading" | "playing" | "paused" | "finished" | "error";
type NarrationSource = "ai" | "browser" | null;

type BriefListenerProps = {
  /** The Swedish brief text to narrate. */
  text: string;
  /** A short, visible label for this narration control. */
  label?: string;
  className?: string;
};

function canUseSpeechSynthesis() {
  return typeof window !== "undefined"
    && typeof window.speechSynthesis?.speak === "function"
    && typeof window.SpeechSynthesisUtterance === "function";
}

function preferredSwedishVoice(voices: SpeechSynthesisVoice[]) {
  const swedishVoices = voices.filter((voice) => voice.lang.toLowerCase().startsWith("sv-se"));
  const priority = (voice: SpeechSynthesisVoice) => {
    const name = voice.name.toLowerCase();
    if (name.includes("siri")) return 4;
    if (name.includes("enhanced")) return 3;
    if (name.includes("premium")) return 2;
    if (name.includes("swedish")) return 1;
    return 0;
  };

  return [...swedishVoices].sort((first, second) => priority(second) - priority(first))[0] ?? null;
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const wholeSeconds = Math.floor(seconds);
  return `${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, "0")}`;
}

export function BriefListener({ text, label = "Lyssna på briefen", className }: BriefListenerProps) {
  const headingId = useId();
  const audioRef = useRef<HTMLAudioElement>(null);
  const requestRun = useRef(0);
  const audioRun = useRef(0);
  const browserFallbackRun = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  const [state, setState] = useState<ListenerState>("idle");
  const [source, setSource] = useState<NarrationSource>(null);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const narration = text.trim();
  const hasText = narration.length > 0;

  useEffect(() => {
    if (!canUseSpeechSynthesis()) return;

    const refreshVoices = () => {
      voicesRef.current = window.speechSynthesis.getVoices();
    };

    refreshVoices();
    window.speechSynthesis.addEventListener("voiceschanged", refreshVoices);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", refreshVoices);
  }, []);

  useEffect(() => () => {
    requestRun.current += 1;
    controllerRef.current?.abort();
    if (canUseSpeechSynthesis()) window.speechSynthesis.cancel();

    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
  }, []);

  function releaseNativeAudio() {
    audioRun.current = 0;
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }

  function cancelBrowserFallback() {
    if (canUseSpeechSynthesis()) window.speechSynthesis.cancel();
  }

  function isCurrentAiAudio() {
    const audio = audioRef.current;
    const objectUrl = objectUrlRef.current;
    return Boolean(
      audio
      && objectUrl
      && audioRun.current === requestRun.current
      && (audio.currentSrc === objectUrl || audio.src === objectUrl),
    );
  }

  function stop() {
    requestRun.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    releaseNativeAudio();
    cancelBrowserFallback();
    setState("idle");
    setSource(null);
    setProgress(0);
    setCurrentTime(0);
    setDuration(0);
    setNotice(null);
  }

  function startBrowserFallback(run: number) {
    if (run !== requestRun.current || browserFallbackRun.current === run) return;
    browserFallbackRun.current = run;
    releaseNativeAudio();

    if (!canUseSpeechSynthesis()) {
      setSource(null);
      setState("error");
      setNotice("AI-rösten kunde inte hämtas och den här webbläsaren saknar reservröst.");
      return;
    }

    const speech = window.speechSynthesis;
    const voice = preferredSwedishVoice(voicesRef.current.length > 0 ? voicesRef.current : speech.getVoices());
    const utterance = new window.SpeechSynthesisUtterance(narration);
    utterance.lang = "sv-SE";
    utterance.rate = 0.96;
    if (voice) utterance.voice = voice;
    utterance.onboundary = (event) => {
      if (run !== requestRun.current || narration.length === 0) return;
      setProgress(Math.min(99, Math.max(0, Math.round((event.charIndex / narration.length) * 100))));
    };
    utterance.onpause = () => {
      if (run === requestRun.current) setState("paused");
    };
    utterance.onresume = () => {
      if (run === requestRun.current) setState("playing");
    };
    utterance.onend = () => {
      if (run !== requestRun.current) return;
      setProgress(100);
      setState("finished");
    };
    utterance.onerror = (event) => {
      if (run !== requestRun.current) return;
      if (event.error === "canceled" || event.error === "interrupted") return;
      setState("error");
      setNotice("Reservrösten kunde inte läsa upp briefen. Försök igen.");
    };

    setSource("browser");
    setState("playing");
    setProgress(0);
    setCurrentTime(0);
    setDuration(0);
    setNotice("AI-rösten är inte tillgänglig. Reservröst från webbläsaren används.");
    speech.cancel();
    speech.speak(utterance);
  }

  async function startAiNarration() {
    if (!hasText) return;

    const run = requestRun.current + 1;
    requestRun.current = run;
    browserFallbackRun.current = 0;
    controllerRef.current?.abort();
    releaseNativeAudio();
    cancelBrowserFallback();

    const controller = new AbortController();
    controllerRef.current = controller;
    setSource("ai");
    setState("loading");
    setProgress(0);
    setCurrentTime(0);
    setDuration(0);
    setNotice(null);

    try {
      const response = await fetch("/api/audio/brief", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: narration }),
        signal: controller.signal,
      });
      if (!response.ok || !response.headers.get("content-type")?.startsWith("audio/")) {
        throw new Error("AI voice was unavailable");
      }

      const blob = await response.blob();
      if (run !== requestRun.current || controller.signal.aborted) return;
      if (blob.size === 0) throw new Error("AI voice response was empty");

      const objectUrl = URL.createObjectURL(blob);
      if (run !== requestRun.current || controller.signal.aborted) {
        URL.revokeObjectURL(objectUrl);
        return;
      }

      const audio = audioRef.current;
      if (!audio) {
        URL.revokeObjectURL(objectUrl);
        throw new Error("Audio player was unavailable");
      }

      objectUrlRef.current = objectUrl;
      audioRun.current = run;
      audio.src = objectUrl;
      audio.load();
      await audio.play();
      if (run !== requestRun.current || controller.signal.aborted) return;
      setState("playing");
    } catch {
      if (run !== requestRun.current || controller.signal.aborted) return;
      startBrowserFallback(run);
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }

  function playOrPause() {
    if (state === "loading") return;

    if (state === "playing") {
      if (source === "ai") audioRef.current?.pause();
      if (source === "browser" && canUseSpeechSynthesis()) window.speechSynthesis.pause();
      return;
    }

    if (state === "paused") {
      if (source === "ai") {
        const run = requestRun.current;
        void audioRef.current?.play().catch(() => startBrowserFallback(run));
      }
      if (source === "browser" && canUseSpeechSynthesis()) window.speechSynthesis.resume();
      return;
    }

    // A completed AI track is still in the local object URL. Rewind it instead
    // of charging for the same narration a second time.
    if (state === "finished" && source === "ai" && isCurrentAiAudio() && audioRef.current) {
      const run = requestRun.current;
      audioRef.current.currentTime = 0;
      setProgress(0);
      setCurrentTime(0);
      void audioRef.current.play().catch(() => startBrowserFallback(run));
      return;
    }

    void startAiNarration();
  }

  function onAudioLoadedMetadata() {
    if (!isCurrentAiAudio() || !audioRef.current) return;
    setDuration(audioRef.current.duration);
  }

  function onAudioTimeUpdate() {
    if (!isCurrentAiAudio() || !audioRef.current) return;
    const audio = audioRef.current;
    setCurrentTime(audio.currentTime);
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      setProgress(Math.min(99, Math.round((audio.currentTime / audio.duration) * 100)));
    }
  }

  function onAudioPlaying() {
    if (!isCurrentAiAudio()) return;
    setSource("ai");
    setState("playing");
    setNotice(null);
  }

  function onAudioPause() {
    const audio = audioRef.current;
    if (!isCurrentAiAudio() || audio?.ended) return;
    setState("paused");
  }

  function onAudioEnded() {
    if (!isCurrentAiAudio()) return;
    setProgress(100);
    setState("finished");
  }

  function onAudioError() {
    if (!isCurrentAiAudio()) return;
    startBrowserFallback(requestRun.current);
  }

  const statusText = state === "loading"
    ? "Förbereder AI-röst"
    : source === "browser"
      ? state === "playing"
        ? "Reservröst spelar"
        : state === "paused"
          ? "Reservröst pausad"
          : state === "finished"
            ? "Reservröst klar"
            : state === "error"
              ? "Reservröst kunde inte starta"
              : "Reservröst redo"
      : state === "playing"
        ? "AI-röst spelar"
        : state === "paused"
          ? "AI-röst pausad"
          : state === "finished"
            ? "AI-röst klar"
            : state === "error"
              ? "Uppläsningen kunde inte starta"
              : "Redo att läsa upp";
  const primaryLabel = state === "playing"
    ? "Pausa"
    : state === "paused"
      ? "Fortsätt"
      : state === "finished"
        ? "Lyssna igen"
        : state === "error"
          ? "Försök igen"
          : "Lyssna";
  const progressText = source === "ai" && duration > 0
    ? `${formatTime(currentTime)} av ${formatTime(duration)}`
    : source === "browser" && progress > 0
      ? `${progress} procent av texten uppläst`
      : state === "loading"
        ? "AI-röst förbereds"
        : state === "finished"
          ? "Uppläsningen är klar"
          : "Uppläsning har inte startat";

  return (
    <section className={`brief-listener brief-listener--${state}${source === "browser" ? " brief-listener--fallback" : ""}${className ? ` ${className}` : ""}`} aria-labelledby={headingId}>
      <audio
        ref={audioRef}
        preload="metadata"
        aria-hidden="true"
        onLoadedMetadata={onAudioLoadedMetadata}
        onTimeUpdate={onAudioTimeUpdate}
        onPlaying={onAudioPlaying}
        onPause={onAudioPause}
        onEnded={onAudioEnded}
        onError={onAudioError}
      />

      <div className="brief-listener-heading">
        <p className="brief-listener-label" id={headingId}>{label}</p>
        <p className="brief-listener-status" aria-live="polite">{statusText}</p>
      </div>

      <div
        className="brief-listener-progress"
        role="progressbar"
        aria-label="Uppläsningens framsteg"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
        aria-valuetext={progressText}
      >
        <span className="brief-listener-progress-value" style={{ width: `${progress}%` }} />
      </div>

      {source === "ai" && duration > 0 && <p className="brief-listener-fallback">{formatTime(currentTime)} / {formatTime(duration)}</p>}
      {notice && <p className="brief-listener-fallback" role="status">{notice}</p>}

      <div className="brief-listener-actions">
        <button className="brief-listener-primary" type="button" onClick={playOrPause} disabled={!hasText || state === "loading"}>
          {primaryLabel}
        </button>
        {(state === "loading" || state === "playing" || state === "paused" || state === "finished") && (
          <button className="brief-listener-stop" type="button" onClick={stop}>
            Stoppa
          </button>
        )}
      </div>
      {!hasText && <p className="brief-listener-empty" role="status">Det finns ingen text att läsa upp.</p>}
    </section>
  );
}
