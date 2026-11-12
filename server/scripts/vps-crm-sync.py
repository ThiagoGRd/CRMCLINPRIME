#!/usr/bin/env python3
"""Sincronizador Bidirecional ClinPrime Esquadrão (VPS) <-> ClinPrime CRM (Supabase).

1. Lê mensagens individuais (recepcao, layla, diana) gravadas pelo coletor.py em mensagens.db,
   resolve o telefone real mesmo quando o WhatsApp usa @lid (via sender_id ou lid-mapping-*_reverse.json)
   e sincroniza em tempo real (incluindo transcrições de áudio Whisper) com o Supabase via evolution-proxy.
2. Expõe um gateway local autenticado (porta 3199 -> /crm-bridge/) para envio instantâneo de mensagens
   pelo Inbox do CRM e consulta de status ao vivo das pontes Baileys (3102, 3103, 3104).
3. Também consome fila de contingência (status='queued') caso alguma mensagem tenha sido enfileirada.
"""
import json
import os
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from db import DADOS, connect

BASE = Path(__file__).resolve().parent
NUMEROS = BASE / "numeros.json"
LOG = DADOS / "logs" / "crm_sync.log"

SUPABASE_SYNC_URL = os.environ.get(
    "CRM_SUPABASE_SYNC_URL",
    "https://sterdootrqzlnbbidkcj.supabase.co/functions/v1/evolution-proxy",
)
SYSTEM_KEY = os.environ.get(
    "CRM_SYSTEM_KEY",
    "9464b805-4fa0-465e-96fb-0b8cbcfac6a2",
)
ORG_ID = os.environ.get(
    "CRM_ORG_ID",
    "00000000-0000-0000-0000-000000000001",
)
GATEWAY_PORT = int(os.environ.get("CRM_GATEWAY_PORT", "3199"))
SYNC_INSTANCES = ("recepcao", "layla", "diana")
BATCH_SIZE = 120
POLL_SECONDS = 3.0


def log(line: str) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as fh:
        fh.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {line}\n")


def load_numeros() -> dict:
    data = json.loads(NUMEROS.read_text(encoding="utf-8"))
    return {k: v for k, v in data.items() if not k.startswith("_")}


def digits_only(val: str | None) -> str:
    return re.sub(r"\D", "", str(val or ""))


def phone_canon(phone: str | None) -> str | None:
    d = digits_only(phone)
    if d.startswith("55") and len(d) >= 12:
        d = d[2:]
    return (d[:2] + d[-8:]) if len(d) >= 10 else None


# Cache em memória para mapear (numero, chat_id) -> telefone real (ex.: "558299...")
_chat_phone_cache: dict[tuple[str, str], str] = {}


def resolve_phone_for_chat(conn: sqlite3.Connection, numero: str, chat_id: str, sender_id: str | None, own_phone: str) -> str | None:
    if not chat_id:
        return None
    cache_key = (numero, chat_id)
    if cache_key in _chat_phone_cache:
        return _chat_phone_cache[cache_key]

    own_canon = phone_canon(own_phone)

    # 1. O próprio chat_id já é @s.whatsapp.net
    if chat_id.endswith("@s.whatsapp.net"):
        ph = digits_only(chat_id.split("@")[0])
        if ph and phone_canon(ph) != own_canon:
            _chat_phone_cache[cache_key] = ph
            return ph

    # 2. sender_id da própria mensagem é @s.whatsapp.net e não é o número da clínica
    if sender_id and sender_id.endswith("@s.whatsapp.net"):
        ph = digits_only(sender_id.split("@")[0])
        if ph and phone_canon(ph) != own_canon:
            _chat_phone_cache[cache_key] = ph
            return ph

    # 3. Buscar em outras mensagens da mesma conversa (numero, chat_id)
    rows = conn.execute(
        "SELECT DISTINCT sender_id FROM messages WHERE numero=? AND chat_id=? AND sender_id LIKE '%@s.whatsapp.net' LIMIT 5",
        (numero, chat_id),
    ).fetchall()
    for r in rows:
        sid = r["sender_id"] or ""
        ph = digits_only(sid.split("@")[0])
        if ph and phone_canon(ph) != own_canon:
            _chat_phone_cache[cache_key] = ph
            return ph

    # 4. Se chat_id for @lid, consultar arquivo lid-mapping-<lid>_reverse.json da sessão Baileys
    if chat_id.endswith("@lid"):
        lid_num = chat_id.split("@")[0].split(":")[0]
        rev_file = DADOS / "sessoes" / numero / f"lid-mapping-{lid_num}_reverse.json"
        if rev_file.exists():
            try:
                ph = digits_only(json.loads(rev_file.read_text(encoding="utf-8")))
                if ph:
                    _chat_phone_cache[cache_key] = ph
                    return ph
            except Exception:
                pass

    return None


def resolve_chat_id_for_send(numero: str, phone: str, preferred_chat_id: str | None = None) -> str:
    """Descobre o melhor chatId (@lid ou @s.whatsapp.net) para enviar mensagem em `numero`."""
    target_canon = phone_canon(phone)
    with connect(readonly=True) as conn:
        if preferred_chat_id and "@" in preferred_chat_id:
            # Verifica se esse chat_id já existe neste número
            row = conn.execute(
                "SELECT chat_id FROM messages WHERE numero=? AND chat_id=? LIMIT 1",
                (numero, preferred_chat_id),
            ).fetchone()
            if row:
                return preferred_chat_id

        if target_canon:
            # Procura conversa recente nesse número com o mesmo telefone
            rows = conn.execute(
                "SELECT chat_id, sender_id FROM messages WHERE numero=? AND is_group=0 ORDER BY id DESC LIMIT 1500",
                (numero,),
            ).fetchall()
            for r in rows:
                cid = r["chat_id"] or ""
                sid = r["sender_id"] or ""
                if (cid.endswith("@s.whatsapp.net") and phone_canon(cid.split("@")[0]) == target_canon) or (
                    sid.endswith("@s.whatsapp.net") and phone_canon(sid.split("@")[0]) == target_canon
                ):
                    return cid

    d = digits_only(phone)
    if not d.startswith("55") and len(d) >= 10:
        d = "55" + d
    return f"{d}@s.whatsapp.net"


def check_bridges_status(numeros_cfg: dict) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for numero, cfg in numeros_cfg.items():
        porta = cfg.get("porta")
        try:
            req = urllib.request.Request(
                f"http://127.0.0.1:{porta}/health",
                headers={"Host": f"127.0.0.1:{porta}"},
            )
            with urllib.request.urlopen(req, timeout=2.5) as resp:
                h = json.loads(resp.read().decode("utf-8"))
                st = "connected" if h.get("status") == "connected" else "disconnected"
                out[numero] = {"status": st, "port": porta, "phone": cfg.get("telefone"), "uptime": h.get("uptime")}
        except Exception:
            out[numero] = {"status": "disconnected", "port": porta, "phone": cfg.get("telefone")}
    return out


def send_via_bridge(instance: str, phone: str, text: str, chat_id: str | None = None) -> dict:
    numeros_cfg = load_numeros()
    cfg = numeros_cfg.get(instance)
    if not cfg:
        return {"ok": False, "error": f"Instância desconhecida: {instance}"}

    porta = cfg["porta"]
    target_chat = resolve_chat_id_for_send(instance, phone, chat_id)
    payload = json.dumps({"chatId": target_chat, "message": text}).encode("utf-8")
    req = urllib.request.Request(
        f"http://127.0.0.1:{porta}/send",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Host": f"127.0.0.1:{porta}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            res = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        err_body = exc.read().decode("utf-8", errors="replace")
        return {"ok": False, "error": f"HTTP {exc.code}: {err_body}"}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

    if not res.get("success"):
        return {"ok": False, "error": str(res)}

    msg_id = res.get("messageId")
    try:
        with connect() as conn:
            conn.execute(
                "INSERT INTO sent(sent_at, numero, chat_id, text, aprovado_por, message_id) VALUES(?,?,?,?,?,?)",
                (time.time(), instance, target_chat, text, "crm-inbox", msg_id),
            )
            conn.commit()
    except Exception as exc:
        log(f"Aviso ao gravar em sent: {exc!r}")

    return {"ok": True, "messageId": msg_id, "chatId": target_chat}


def format_message_content(row: sqlite3.Row) -> tuple[str, str]:
    kind = (row["kind"] or "texto").lower()
    raw_text = (row["text"] or "").strip()
    transcript = (row["transcript"] or "").strip()

    if kind == "audio":
        if transcript and not transcript.startswith("[falha"):
            return f"🎤 [Áudio]: {transcript}", "audio"
        return "🎤 [Áudio recebido]", "audio"

    if kind == "foto":
        clean = "" if raw_text in ("[image received]", "[photo received]") else raw_text
        return (f"📷 [Foto] {clean}".strip() if clean else "📷 [Foto]"), "image"

    if kind == "video":
        clean = "" if raw_text == "[video received]" else raw_text
        return (f"🎥 [Vídeo] {clean}".strip() if clean else "🎥 [Vídeo]"), "video"

    if kind == "document":
        clean = "" if raw_text == "[document received]" else raw_text
        return (f"📄 [Documento] {clean}".strip() if clean else "📄 [Documento]"), "document"

    if kind == "sticker":
        return "🏷️ [Figurinha]", "sticker"

    return (raw_text or f"[{kind}]"), "text"


def call_supabase_edge(action: str, payload: dict) -> dict | None:
    body = json.dumps({"action": action, "payload": {"org_id": ORG_ID, **payload}}).encode("utf-8")
    req = urllib.request.Request(
        SUPABASE_SYNC_URL,
        data=body,
        headers={
            "Content-Type": "application/json",
            "x-system-key": SYSTEM_KEY,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        err_txt = exc.read().decode("utf-8", errors="replace")[:300]
        log(f"ERRO Supabase Edge ({action}) HTTP {exc.code}: {err_txt}")
        return None
    except Exception as exc:
        log(f"ERRO Supabase Edge ({action}): {exc!r}")
        return None


# ---------------------------------------------------------------- Gateway HTTP
class GatewayHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        return  # silencia log por request

    def _reply(self, status: int, data: dict) -> None:
        raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _authorized(self) -> bool:
        return self.headers.get("x-system-key") == SYSTEM_KEY

    def do_GET(self) -> None:
        if not self._authorized():
            self._reply(401, {"ok": False, "error": "unauthorized"})
            return
        parsed = urlparse(self.path)
        if parsed.path in ("/status", "/crm-bridge/status", "/health", "/crm-bridge/health"):
            cfg = load_numeros()
            st = check_bridges_status(cfg)
            self._reply(200, {"ok": True, "instances": st})
            return
        self._reply(404, {"ok": False, "error": "not_found"})

    def do_POST(self) -> None:
        if not self._authorized():
            self._reply(401, {"ok": False, "error": "unauthorized"})
            return
        parsed = urlparse(self.path)
        if parsed.path in ("/send", "/crm-bridge/send"):
            length = int(self.headers.get("Content-Length") or "0")
            raw = self.rfile.read(length) if length > 0 else b"{}"
            try:
                body = json.loads(raw.decode("utf-8"))
            except Exception:
                self._reply(400, {"ok": False, "error": "invalid_json"})
                return
            instance = str(body.get("instance") or "recepcao").strip()
            phone = str(body.get("phone") or "").strip()
            chat_id = body.get("chat_id")
            text = str(body.get("text") or "").strip()
            if not phone or not text:
                self._reply(400, {"ok": False, "error": "phone and text are required"})
                return
            res = send_via_bridge(instance, phone, text, chat_id)
            self._reply(200 if res.get("ok") else 502, res)
            return
        self._reply(404, {"ok": False, "error": "not_found"})


# ---------------------------------------------------------------- Loop de Sync
def get_cursor(conn: sqlite3.Connection, key: str, default_val: int) -> int:
    row = conn.execute("SELECT last_id FROM cursors WHERE key=?", (key,)).fetchone()
    if row is not None:
        return int(row["last_id"])
    conn.execute("INSERT INTO cursors(key, last_id) VALUES(?, ?)", (key, default_val))
    conn.commit()
    return default_val


def set_cursor(conn: sqlite3.Connection, key: str, val: int) -> None:
    conn.execute(
        "INSERT INTO cursors(key, last_id) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET last_id=excluded.last_id",
        (key, val),
    )
    conn.commit()


def sync_loop() -> None:
    log("Loop de sincronização CRM iniciado")
    pending_audio_ids: set[int] = set()

    # Inicializa cursor nas últimas ~600 mensagens para entrar em tempo real imediatamente
    with connect() as conn:
        row = conn.execute(
            "SELECT COALESCE(MAX(id), 0) AS max_id FROM messages",
        ).fetchone()
        initial_id = max(0, int(row["max_id"] or 0) - 600)
        last_id = get_cursor(conn, "crm_sync_last_id", initial_id)
        log(f"Cursor inicial crm_sync_last_id = {last_id}")

    while True:
        try:
            numeros_cfg = load_numeros()
            bridge_st = check_bridges_status(numeros_cfg)
            statuses_payload = {k: v["status"] for k, v in bridge_st.items()}

            batch_items = []
            max_row_id = last_id

            with connect(readonly=True) as conn:
                rows = conn.execute(
                    "SELECT id, numero, received_at, msg_ts, chat_id, is_group, sender_id, sender_name, "
                    "from_owner, message_id, kind, text, transcript, chat_label "
                    "FROM messages "
                    "WHERE id > ? AND is_group = 0 AND numero IN ('recepcao', 'layla', 'diana') "
                    "ORDER BY id ASC LIMIT ?",
                    (last_id, BATCH_SIZE),
                ).fetchall()

                # Verificar também áudios recentes que ganharam transcrição
                audio_rows = []
                if pending_audio_ids:
                    placeholders = ",".join("?" for _ in pending_audio_ids)
                    audio_rows = conn.execute(
                        f"SELECT id, numero, received_at, msg_ts, chat_id, is_group, sender_id, sender_name, "
                        f"from_owner, message_id, kind, text, transcript, chat_label "
                        f"FROM messages WHERE id IN ({placeholders}) AND transcript IS NOT NULL",
                        tuple(pending_audio_ids),
                    ).fetchall()

                all_rows = list(rows) + list(audio_rows)
                for r in rows:
                    if r["id"] > max_row_id:
                        max_row_id = r["id"]
                    if (r["kind"] or "").lower() == "audio" and not r["transcript"]:
                        pending_audio_ids.add(r["id"])

                for r in audio_rows:
                    pending_audio_ids.discard(r["id"])

                # Limita tamanho do set de áudios pendentes
                if len(pending_audio_ids) > 200:
                    pending_audio_ids = set(sorted(pending_audio_ids)[-100:])

                for r in all_rows:
                    numero = r["numero"]
                    own_phone = numeros_cfg.get(numero, {}).get("telefone", "")
                    phone = resolve_phone_for_chat(conn, numero, r["chat_id"], r["sender_id"], own_phone)
                    if not phone:
                        continue
                    content, msg_type = format_message_content(r)
                    msg_id = r["message_id"] or f"local-{r['id']}"
                    ts = r["msg_ts"] or r["received_at"]
                    contact_name = r["chat_label"] if r["from_owner"] else (r["sender_name"] or r["chat_label"])
                    batch_items.append(
                        {
                            "instance": numero,
                            "phone": phone,
                            "chat_id": r["chat_id"],
                            "sender_name": contact_name,
                            "chat_label": r["chat_label"],
                            "from_owner": bool(r["from_owner"]),
                            "wamid": f"{numero}:{msg_id}",
                            "content": content,
                            "message_type": msg_type,
                            "timestamp": ts,
                        }
                    )

            res = call_supabase_edge(
                "vps_sync",
                {
                    "statuses": statuses_payload,
                    "messages": batch_items,
                },
            )

            if res and res.get("ok"):
                if max_row_id > last_id:
                    with connect() as conn_w:
                        set_cursor(conn_w, "crm_sync_last_id", max_row_id)
                    last_id = max_row_id
                    log(f"Sincronizadas {res.get('synced', 0)} msgs (cursor={last_id})")

                # Processar fila de contingência outbound ('queued')
                for q in res.get("queued_outbound") or []:
                    q_id = q.get("id")
                    send_res = send_via_bridge(
                        q.get("instance") or "recepcao",
                        q.get("phone") or "",
                        q.get("text") or "",
                        q.get("chat_id"),
                    )
                    wamid = f"{q.get('instance')}:{send_res.get('messageId')}" if send_res.get("ok") and send_res.get("messageId") else None
                    call_supabase_edge(
                        "vps_ack_outbound",
                        {
                            "message_id": q_id,
                            "ok": bool(send_res.get("ok")),
                            "wamid": wamid,
                        },
                    )
                    log(f"Fila outbound id={q_id} enviada via {q.get('instance')}: ok={send_res.get('ok')}")

            # Se ainda há lote grande para alcançar o topo, dorme menos (0.4s); senão 3s
            if len(rows) >= BATCH_SIZE:
                time.sleep(0.4)
            else:
                time.sleep(POLL_SECONDS)

        except Exception as exc:
            log(f"ERRO no loop principal: {exc!r}")
            time.sleep(5)


def main() -> None:
    server = ThreadingHTTPServer(("0.0.0.0", GATEWAY_PORT), GatewayHandler)
    t = threading.Thread(target=server.serve_forever, daemon=True, name="crm-gateway")
    t.start()
    log(f"Gateway HTTP do CRM ouvindo em 0.0.0.0:{GATEWAY_PORT}")
    sync_loop()


if __name__ == "__main__":
    main()
