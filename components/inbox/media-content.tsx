"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { hasFetchableMedia, type InboxMessage, type MediaKind } from "@/lib/inbox";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Camera, Download, FileText, Mic, Pause, Play, Sticker, Video } from "lucide-react";

// supabase.functions.invoke lê image/* e audio/* como texto (só octet-stream/pdf viram Blob), o que corrompe
// os bytes; por isso a chamada vai direto à função, com o mesmo token da sessão.
async function fetchMedia(id: string): Promise<Blob> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/wa-media`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      Authorization: `Bearer ${session?.access_token ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ id }),
  });
  const blob = res.ok ? await res.blob() : null;
  if (!blob || blob.type.startsWith("application/json")) throw new Error("media");
  return blob;
}

function useNearViewport<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    if (typeof IntersectionObserver === "undefined") {
      const t = setTimeout(() => setNear(true));
      return () => clearTimeout(t);
    }
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) { setNear(true); io.disconnect(); } },
      { root: el.closest("[data-chat-scroll]"), rootMargin: "400px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  return [ref, near] as const;
}

// A URL do blob só existe em memória enquanto o balão está na tela.
function useObjectUrl(blob: Blob | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return;
    const u = URL.createObjectURL(blob);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- criar e revogar a URL no mesmo efeito resiste ao StrictMode
    setUrl(u);
    return () => { URL.revokeObjectURL(u); setUrl(null); };
  }, [blob]);
  return url;
}

export function BubbleText({ text, muted }: { text: string; muted?: boolean }) {
  if (!text) return null;
  return (
    <p className={`whitespace-pre-wrap break-words ${muted ? "text-[12.5px] leading-snug text-foreground/60" : ""}`}>
      {text}
      {/* reserva o espaço da hora, que fica no canto do balão */}
      <span aria-hidden className="inline-block w-12" />
    </p>
  );
}

const KIND_META: Record<Exclude<MediaKind, "text">, { label: string; Icon: typeof Camera }> = {
  image: { label: "Foto", Icon: Camera },
  audio: { label: "Áudio", Icon: Mic },
  document: { label: "Documento", Icon: FileText },
  video: { label: "Vídeo", Icon: Video },
  sticker: { label: "Figurinha", Icon: Sticker },
};

function Placeholder({ kind, text }: { kind: Exclude<MediaKind, "text">; text: string }) {
  const { label, Icon } = KIND_META[kind];
  // figurinha: arquivo ainda não disponível, só um marcador discreto
  if (kind === "sticker") {
    return (
      <div className="flex items-center gap-2 pr-12 pb-3 text-[13px] text-foreground/70">
        <span className="grid size-7 place-items-center rounded-md bg-white/[0.06]"><Icon aria-hidden className="size-4" /></span>
        {label}
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <div className="flex w-[240px] max-w-full items-center gap-3 rounded-lg bg-black/20 p-2.5 ring-1 ring-white/[0.06]">
        <div className="grid size-10 shrink-0 place-items-center rounded-md bg-white/[0.06] text-foreground/70">
          <Icon className="size-5" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium">{label}</p>
          <p className="text-[11px] text-muted-foreground">
            {kind === "video" ? "Vídeo ainda não disponível aqui" : "Arquivo não disponível"}
          </p>
        </div>
      </div>
      {kind === "document" ? <BubbleText text={text} muted /> : <BubbleText text={text} />}
      {!text && <div aria-hidden className="h-3" />}
    </div>
  );
}

function fileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}

const extOf = (type: string) => (type.split("/")[1] ?? "").split(";")[0].replace("jpeg", "jpg").replace("vnd.openxmlformats-officedocument.", "");

function ImageMedia({ url, blob, caption, alt }: { url: string | null; blob?: Blob; caption: string; alt: string }) {
  const [open, setOpen] = useState(false);
  // altura pela proporção real da foto, entre 140 e 320px; o lightbox mostra a foto inteira
  const [ratio, setRatio] = useState(0.75);
  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!url}
        aria-label="Ampliar foto"
        className="group/img relative block w-[280px] max-w-full overflow-hidden rounded-lg bg-black/30 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ height: Math.round(Math.min(320, Math.max(140, 280 * ratio))) }}
      >
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element -- blob em memória, next/image não se aplica
          <img
            src={url} alt={alt}
            onLoad={(e) => { const i = e.currentTarget; if (i.naturalWidth) setRatio(i.naturalHeight / i.naturalWidth); }}
            className="block h-full max-h-[320px] w-full max-w-[280px] object-cover transition-transform duration-300 group-hover/img:scale-[1.03] motion-reduce:transition-none" />
        ) : (
          <span className="flex size-full items-center justify-center motion-safe:animate-pulse">
            <Camera className="size-7 text-white/20" />
          </span>
        )}
      </button>
      <BubbleText text={caption} />
      {!caption && <div aria-hidden className="h-3" />}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[min(94vw,1100px)] gap-3 bg-[#05060a]/95 p-3 sm:max-w-[min(94vw,1100px)]">
          <DialogTitle className="sr-only">Foto</DialogTitle>
          {url && (
            // eslint-disable-next-line @next/next/no-img-element -- blob em memória, next/image não se aplica
            <img src={url} alt={alt} className="mx-auto max-h-[78vh] w-auto rounded-md object-contain" />
          )}
          <div className="flex items-center justify-between gap-3 px-1">
            <p className="min-w-0 truncate text-sm text-foreground/80">{caption}</p>
            {url && (
              <a
                href={url}
                download={`foto.${extOf(blob?.type ?? "") || "jpg"}`}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-white/12 px-3 text-xs font-medium hover:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <Download className="size-3.5" /> Baixar
              </a>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

const RATES = [1, 1.5, 2];

// forma de onda decorativa, fixa por mensagem (alturas em %)
function waveform(seed: string): number[] {
  let h = 7;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  const out: number[] = [];
  for (let i = 0; i < 34; i++) { h = (h * 1103515245 + 12345) | 0; out.push(22 + (Math.abs(h >> 8) % 78)); }
  return out;
}

function AudioMedia({ url, seed, transcript, outbound }: { url: string | null; seed: string; transcript: string; outbound: boolean }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  const bars = useMemo(() => waveform(seed), [seed]);
  const progress = duration > 0 ? Math.min(1, time / duration) : 0;
  const readDuration = () => { const d = audioRef.current?.duration ?? 0; if (Number.isFinite(d)) setDuration(d); };

  function toggle() {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void a.play().catch(() => setPlaying(false));
    else a.pause();
  }
  function cycleRate() {
    const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
    setRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  }

  return (
    <div className="space-y-1.5">
      <div className="flex w-[260px] max-w-full items-center gap-2.5 py-0.5">
        {url && (
          <audio
            ref={audioRef} src={url} preload="metadata"
            onLoadedMetadata={readDuration} onDurationChange={readDuration}
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
            onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
            onEnded={() => { setPlaying(false); setTime(0); }}
          />
        )}
        <button
          type="button" onClick={toggle} disabled={!url}
          aria-label={playing ? "Pausar áudio" : "Reproduzir áudio"}
          className={`grid size-9 shrink-0 place-items-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${
            outbound ? "bg-white/90 text-primary hover:bg-white" : "bg-primary text-primary-foreground hover:bg-primary/85"
          }`}
        >
          {playing ? <Pause className="size-4 fill-current" /> : <Play className="ml-0.5 size-4 fill-current" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="relative flex h-7 items-center gap-[2px] rounded has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
            {bars.map((b, i) => (
              <span
                key={i} aria-hidden
                className={`w-[3px] shrink-0 rounded-full transition-colors duration-150 ${
                  !url ? "bg-white/10 motion-safe:animate-pulse" : i / bars.length < progress ? (outbound ? "bg-white" : "bg-primary") : "bg-white/25"
                }`}
                style={{ height: `${b}%` }}
              />
            ))}
            <input
              type="range" min={0} max={duration || 0} step={0.1} value={Math.min(time, duration || 0)}
              disabled={!url || !duration}
              aria-label="Posição do áudio"
              onChange={(e) => { const v = Number(e.target.value); setTime(v); if (audioRef.current) audioRef.current.currentTime = v; }}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
            />
          </div>
          <div className="mt-0.5 flex items-center justify-between text-[10.5px] tabular-nums text-foreground/55">
            <span>{fmtTime(playing || time > 0 ? time : duration)}</span>
            <button
              type="button" onClick={cycleRate} disabled={!url}
              aria-label={`Velocidade ${rate}x`}
              className="mr-12 rounded-full bg-white/10 px-1.5 py-px text-[10px] font-semibold text-foreground/80 outline-none hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
            >
              {String(rate).replace(".", ",")}x
            </button>
          </div>
        </div>
      </div>
      {transcript && (
        <p className="border-l-2 border-white/15 pl-2 text-[12.5px] leading-snug whitespace-pre-wrap break-words text-foreground/60">
          {transcript}
          <span aria-hidden className="inline-block w-12" />
        </p>
      )}
    </div>
  );
}

function DocumentMedia({ url, blob, name }: { url: string | null; blob?: Blob; name: string }) {
  const ext = extOf(blob?.type ?? "");
  return (
    <div className="space-y-1">
      <div className="flex w-[260px] max-w-full items-center gap-3 rounded-lg bg-black/20 p-2.5 ring-1 ring-white/[0.06]">
        <div className="grid size-10 shrink-0 place-items-center rounded-md bg-rose-500/15 text-rose-300">
          <FileText className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={name || undefined}>{name || "Documento"}</p>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {blob ? `${ext || "arquivo"} · ${fileSize(blob.size)}` : <span className="inline-block h-2.5 w-16 rounded bg-white/10 align-middle motion-safe:animate-pulse" />}
          </p>
        </div>
        {url && (
          <a
            href={url} target="_blank" rel="noopener noreferrer"
            aria-label={`Abrir ${name || "documento"}`}
            className="shrink-0 rounded-md px-2.5 py-1.5 text-xs font-semibold text-primary outline-none hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-ring"
          >
            Abrir
          </a>
        )}
      </div>
      <div aria-hidden className="h-3" />
    </div>
  );
}

export function MediaContent({ message, kind, text, alt, outbound }: {
  message: InboxMessage; kind: Exclude<MediaKind, "text">; text: string; alt: string; outbound: boolean;
}) {
  const fetchable = hasFetchableMedia(message) && kind !== "video" && kind !== "sticker";
  const [ref, near] = useNearViewport<HTMLDivElement>();
  const q = useQuery({
    queryKey: ["wa-media", message.id],
    queryFn: () => fetchMedia(message.id),
    enabled: fetchable && near,
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    retry: false,
  });
  const url = useObjectUrl(q.data);

  let body: React.ReactNode;
  if (!fetchable) body = <Placeholder kind={kind} text={text} />;
  // sem arquivo (404) ou falha: mostra o texto como antes, sem aviso
  else if (q.isError) body = <BubbleText text={message.content} />;
  else if (kind === "image") body = <ImageMedia url={url} blob={q.data} caption={text} alt={alt} />;
  else if (kind === "audio") body = <AudioMedia url={url} seed={message.id} transcript={text} outbound={outbound} />;
  else body = <DocumentMedia url={url} blob={q.data} name={text} />;

  return <div ref={ref}>{body}</div>;
}
