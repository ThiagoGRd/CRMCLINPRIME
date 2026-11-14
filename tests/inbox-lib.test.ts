import test from "node:test";
import assert from "node:assert/strict";
import { parseMediaContent, lastByPatient, awaitingReply, listTime, dayLabel, avatarColor, AVATAR_PALETTE, hasFetchableMedia } from "../lib/inbox.ts";

const now = new Date("2026-11-14T15:00:00-03:00");

test("parseMediaContent reconhece os prefixos do sincronizador", () => {
  assert.deepEqual(parseMediaContent("📷 [Foto]", "image"), { kind: "image", text: "" });
  assert.deepEqual(parseMediaContent("📷 [Foto] Olha o dente", "image"), { kind: "image", text: "Olha o dente" });
  assert.deepEqual(parseMediaContent("🎤 [Áudio]: quero marcar amanhã", "audio"), { kind: "audio", text: "quero marcar amanhã" });
  assert.deepEqual(parseMediaContent("🎤 [Áudio recebido]", "audio"), { kind: "audio", text: "" });
  assert.deepEqual(parseMediaContent("📄 [Documento]", "document"), { kind: "document", text: "" });
  assert.deepEqual(parseMediaContent("📄 [Documento] exame.pdf", "document"), { kind: "document", text: "exame.pdf" });
  assert.deepEqual(parseMediaContent("🎥 [Vídeo]", "video"), { kind: "video", text: "" });
  assert.deepEqual(parseMediaContent("🎥 [Vídeo] antes e depois", "video"), { kind: "video", text: "antes e depois" });
});

test("parseMediaContent deixa texto comum como está", () => {
  assert.deepEqual(parseMediaContent("Bom dia! [Foto] depois", "text"), { kind: "text", text: "Bom dia! [Foto] depois" });
  assert.deepEqual(parseMediaContent("oi", null), { kind: "text", text: "oi" });
  assert.deepEqual(parseMediaContent(null, null), { kind: "text", text: "" });
  assert.deepEqual(parseMediaContent("oi", "image"), { kind: "image", text: "oi" });
});

test("hasFetchableMedia exige tipo com arquivo e id com dois-pontos", () => {
  assert.equal(hasFetchableMedia({ message_type: "image", whatsapp_message_id: "chat:ABC" }), true);
  assert.equal(hasFetchableMedia({ message_type: "audio", whatsapp_message_id: "ABC" }), false);
  assert.equal(hasFetchableMedia({ message_type: "video", whatsapp_message_id: "chat:ABC" }), false);
  assert.equal(hasFetchableMedia({ message_type: null, whatsapp_message_id: null }), false);
});

test("lastByPatient pega a primeira linha (mais nova) de cada paciente", () => {
  const rows = [
    { patient_id: "a", direction: "inbound", created_at: "2026-11-14T12:00:00Z" },
    { patient_id: "b", direction: "outbound", created_at: "2026-11-14T11:00:00Z" },
    { patient_id: "a", direction: "outbound", created_at: "2026-11-14T10:00:00Z" },
    { patient_id: "b", direction: "inbound", created_at: "2026-11-14T09:00:00Z" },
  ];
  const last = lastByPatient(rows);
  assert.equal(last.size, 2);
  assert.equal(last.get("a"), rows[0]);
  assert.equal(last.get("b"), rows[1]);
});

test("awaitingReply: recebida espera, enviada não", () => {
  assert.equal(awaitingReply({ direction: "inbound" }), true);
  assert.equal(awaitingReply({ direction: "outbound" }), false);
});

test("listTime: hora hoje, ontem, ou dia/mês, no fuso de São Paulo", () => {
  assert.equal(listTime("2026-11-14T12:10:00-03:00", now), "12:10");
  assert.equal(listTime("2026-11-13T09:00:00-03:00", now), "ontem");
  assert.equal(listTime("2026-11-10T09:00:00-03:00", now), "10/11");
  assert.equal(listTime("2026-11-14T02:30:00Z", now), "ontem");
});

test("dayLabel: Hoje, Ontem ou data completa", () => {
  assert.equal(dayLabel("2026-11-14T08:00:00-03:00", now), "Hoje");
  assert.equal(dayLabel("2026-11-13T22:00:00-03:00", now), "Ontem");
  assert.equal(dayLabel("2026-11-10T08:00:00-03:00", now), "10/11/2026");
});

test("avatarColor é determinística e vem da paleta", () => {
  assert.equal(avatarColor("paciente-1"), avatarColor("paciente-1"));
  assert.ok(AVATAR_PALETTE.includes(avatarColor("paciente-1")));
  assert.ok(AVATAR_PALETTE.includes(avatarColor("")));
});
