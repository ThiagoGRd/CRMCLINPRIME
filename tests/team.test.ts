import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { validateInvite, inviteMember, updateMember } from "../lib/team.ts";

const ok = { email: "ana@clinica.com", displayName: "Ana", front: "recepcao" };
const input = { email: "ana@clinica.com", displayName: "Ana", front: "recepcao", isManager: false } as const;

function clientWith(fetch: typeof globalThis.fetch) {
  return createClient("http://localhost:54321", "synthetic-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch },
  });
}
const res = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("validateInvite devolve a mensagem do primeiro campo inválido", () => {
  assert.equal(validateInvite({ ...ok, email: "x" }), "E-mail inválido.");
  assert.equal(validateInvite({ ...ok, displayName: "   " }), "Informe o nome.");
  assert.equal(validateInvite({ ...ok, front: "financeiro" }), "Frente inválida.");
  assert.equal(validateInvite(ok), null);
});

test("inviteMember faz POST em team-invite sem org_id no corpo", async () => {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const client = clientWith(async (i, init) => { calls.push({ url: new URL(String(i)), init }); return res({ ok: true, user_id: "u" }, 200); });
  await inviteMember(client, { ...input, email: "  ANA@Clinica.com ", isManager: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/functions/v1/team-invite");
  assert.equal(calls[0].init?.method, "POST");
  const body = JSON.parse(String(calls[0].init?.body));
  assert.deepEqual(body, { email: "ana@clinica.com", display_name: "Ana", front: "recepcao", is_manager: true });
  assert.ok(!("org_id" in body));
});

test("inviteMember traduz o status HTTP em mensagem", async () => {
  const cases: [number, unknown, string][] = [
    [401, {}, "Sua sessão expirou. Entre de novo."],
    [403, { error: "x" }, "Só o administrador pode adicionar membros."],
    [409, {}, "Esta pessoa já faz parte da equipe."],
    [400, { error: "E-mail inválido." }, "E-mail inválido."],
    [400, {}, "Dados inválidos."],
    [500, { error: "interno" }, "Não foi possível adicionar o membro. Tente de novo."],
  ];
  for (const [status, body, msg] of cases) {
    const client = clientWith(async () => res(body, status));
    await assert.rejects(inviteMember(client, input), { message: msg });
  }
});

test("inviteMember não chama a função com dados inválidos", async () => {
  let n = 0;
  const client = clientWith(async () => { n++; return res({}, 200); });
  await assert.rejects(inviteMember(client, { ...input, email: "x" }), { message: "E-mail inválido." });
  assert.equal(n, 0);
});

test("updateMember filtra por id e organização", async () => {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const client = clientWith(async (i, init) => { calls.push({ url: new URL(String(i)), init }); return res([{ id: "m1" }], 200); });
  await updateMember(client, { memberId: "m1", orgId: "o1", front: null, isManager: true });
  const { url, init } = calls[0];
  assert.equal(init?.method, "PATCH");
  assert.equal(url.searchParams.get("id"), "eq.m1");
  assert.equal(url.searchParams.get("org_id"), "eq.o1");
  assert.deepEqual(JSON.parse(String(init?.body)), { front: null, is_manager: true });
});

test("updateMember rejeita quando o banco não altera nenhuma linha", async () => {
  const client = clientWith(async () => res([], 200));
  await assert.rejects(updateMember(client, { memberId: "m1", orgId: "o1", front: "comercial", isManager: false }), { message: "Não foi possível atualizar o membro. Tente de novo." });
});
