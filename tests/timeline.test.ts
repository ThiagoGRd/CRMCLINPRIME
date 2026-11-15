import test from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, matchByPhone } from "../lib/timeline.ts";

test("mistura as quatro fontes, mais recente primeiro", () => {
  const out = buildTimeline({
    messages: [{ created_at: "2026-11-10T13:00:00Z", direction: "inbound", content: "Oi", message_type: "text" }],
    attendances: [{ appt_date: "2026-11-12", from_time: "09:00", status: "faltou", category: "Avaliação" }],
    estimates: [{ est_date: "2026-11-13", status: "APPROVED", amount: 7500 }],
    tasks: [{ dueAt: "2026-11-11T13:00:00Z", title: "Ligar", status: "feita" }],
  });
  assert.deepEqual(out.map((x) => x.kind), ["orcamento", "consulta", "tarefa", "mensagem"]);
  assert.equal(out[0].tone, "bom");
  assert.equal(out[1].tone, "ruim");
});
test("mensagem sem texto mostra o tipo", () => {
  const out = buildTimeline({ messages: [{ created_at: "2026-11-10T13:00:00Z", direction: "inbound", content: null, message_type: "audio" }], attendances: [], estimates: [], tasks: [] });
  assert.equal(out[0].title, "Áudio");
});
test("tudo vazio devolve lista vazia", () => {
  assert.deepEqual(buildTimeline({ messages: [], attendances: [], estimates: [], tasks: [] }), []);
});
test("data sem hora conta como 12h de Brasília; consulta usa a hora marcada", () => {
  const out = buildTimeline({
    messages: [],
    attendances: [{ appt_date: "2026-11-12", from_time: "09:00", status: "compareceu", category: null }],
    estimates: [{ est_date: "2026-11-12", status: "REJECTED", amount: 1000 }],
    tasks: [],
  });
  assert.deepEqual(out.map((x) => x.at), ["2026-11-12T15:00:00.000Z", "2026-11-12T12:00:00.000Z"]);
  assert.equal(out[0].title, "Orçamento");
  assert.equal(out[0].tone, "ruim");
  assert.equal(out[1].title, "Consulta: Consulta");
  assert.equal(out[1].detail, "Compareceu");
  assert.equal(out[1].tone, "bom");
});
test("datas ruins não derrubam: item some, hora ilegível vira 12h", () => {
  const out = buildTimeline({
    messages: [{ created_at: "", direction: "inbound", content: "x", message_type: "text" }],
    attendances: [
      { appt_date: null as unknown as string, from_time: null, status: "agendado", category: "Nula" },
      { appt_date: "2026-11-12", from_time: "xx", status: "agendado", category: "Hora ruim" },
    ],
    estimates: [{ est_date: "abc", status: "OPEN", amount: 1 }],
    tasks: [],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "Consulta: Hora ruim");
  assert.equal(out[0].at, "2026-11-12T15:00:00.000Z");
});
test("matchByPhone casa formatado, com 55 e sem; rejeita outro número", () => {
  const canon = (p: string) => { let d = p.replace(/\D/g, ""); if (d.startsWith("55") && d.length >= 12) d = d.slice(2); return d.length < 10 ? null : d.slice(0, 2) + d.slice(-8); };
  const rows = ["(82) 99121-2108", "5582991212108", "82991212108", "(82) 98888-2108"].map((phone) => ({ phone }));
  assert.deepEqual(matchByPhone(rows, canon("82991212108"), canon).map((r) => r.phone), rows.slice(0, 3).map((r) => r.phone));
});
