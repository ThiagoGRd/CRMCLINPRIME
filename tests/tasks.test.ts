import test from "node:test";
import assert from "node:assert/strict";
import { slaMinutes, demandDueAt, urgency, sortQueue, demandTitle, validateCompletion, visibleTo } from "../lib/tasks.ts";

const now = new Date("2026-11-14T15:00:00-03:00");
const t = (id: string, dueAt: string, ownerId: string | null = "u1") =>
  ({ id, patientId: "p", patientName: "Ana", patientPhone: "", front: "recepcao", kind: "demanda", title: "x", ownerId, dueAt, status: "aberta", draft: null }) as const;

test("sla usa o padrão e aceita sobrescrita da organização", () => {
  assert.equal(slaMinutes("recepcao", null), 30);
  assert.equal(slaMinutes("pos_venda", {}), 1440);
  assert.equal(slaMinutes("recepcao", { sla: { recepcao: 15 } }), 15);
  assert.equal(slaMinutes("recepcao", { sla: { recepcao: "abc" } }), 30);
});
test("prazo da demanda é agora mais o sla", () => {
  assert.equal(demandDueAt(now, "recepcao", null).toISOString(), new Date("2026-11-14T15:30:00-03:00").toISOString());
});
test("23h30 de Brasília ainda é hoje", () => {
  assert.equal(urgency("2026-11-14T23:30:00-03:00", now), "hoje");
  assert.equal(urgency("2026-11-15T00:10:00-03:00", now), "futura");
  assert.equal(urgency("2026-11-14T14:59:00-03:00", now), "vencida");
});
test("fila: vencidas, depois hoje, depois futuras, por prazo", () => {
  const out = sortQueue([t("c", "2026-11-20T10:00:00-03:00"), t("b", "2026-11-14T18:00:00-03:00"), t("a2", "2026-11-14T12:00:00-03:00"), t("a1", "2026-11-13T12:00:00-03:00")], now);
  assert.deepEqual(out.map((x) => x.id), ["a1", "a2", "b", "c"]);
});
test("título da demanda cai para o nome quando não há texto", () => {
  assert.equal(demandTitle("  ", "Ana Souza"), "Demanda de Ana Souza");
  assert.equal(demandTitle(null, "Ana Souza"), "Demanda de Ana Souza");
  assert.equal(demandTitle("a".repeat(200), "Ana").length, 80);
  assert.equal(demandTitle("Quero remarcar", "Ana"), "Quero remarcar");
});
test("concluir exige próxima ação no futuro ou motivo de encerramento", () => {
  assert.equal(validateCompletion({ nextTitle: "", nextDue: "", closeReason: "" }, now), "Informe a próxima ação ou encerre o paciente com um motivo.");
  assert.equal(validateCompletion({ nextTitle: "Ligar", nextDue: "2026-11-14T10:00:00-03:00", closeReason: "" }, now), "O prazo da próxima ação precisa ser no futuro.");
  assert.equal(validateCompletion({ nextTitle: "Ligar", nextDue: "não é data", closeReason: "" }, now), "O prazo da próxima ação precisa ser no futuro.");
  assert.equal(validateCompletion({ nextTitle: "Ligar", nextDue: "2026-11-15T10:00:00-03:00", closeReason: "" }, now), null);
  assert.equal(validateCompletion({ nextTitle: "", nextDue: "", closeReason: "Perdido: preço" }, now), null);
});
test("tarefa sem responsável ou de quem saiu aparece só para o gestor", () => {
  const me = { userId: "u1", isManager: false }, boss = { userId: "u9", isManager: true };
  assert.equal(visibleTo(t("a", now.toISOString(), "u1"), me, ["u1", "u9"]), true);
  assert.equal(visibleTo(t("a", now.toISOString(), null), me, ["u1", "u9"]), false);
  assert.equal(visibleTo(t("a", now.toISOString(), null), boss, ["u1", "u9"]), true);
  assert.equal(visibleTo(t("a", now.toISOString(), "saiu"), boss, ["u1", "u9"]), true);
  assert.equal(visibleTo(t("a", now.toISOString(), "u1"), boss, ["u1", "u9"]), true);
});
