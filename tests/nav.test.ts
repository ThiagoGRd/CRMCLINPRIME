import test from "node:test";
import assert from "node:assert/strict";
import { NAV, navByHref } from "../lib/nav.ts";

test("menu tem os 8 itens na ordem do design", () => {
  assert.deepEqual(NAV.map((n) => n.href), ["/fila", "/inbox", "/pacientes", "/agenda", "/funil", "/automacoes", "/gestao", "/configuracoes"]);
  assert.deepEqual(NAV.map((n) => n.label), ["Minha fila", "Conversas", "Pacientes", "Agenda", "Funil", "Cadências", "Gestão", "Configurações"]);
});
test("só a fila tem contador", () => {
  assert.deepEqual(NAV.filter((n) => n.badge).map((n) => n.href), ["/fila"]);
});
test("navByHref acha a fila", () => {
  assert.equal(navByHref("/fila")?.label, "Minha fila");
});
