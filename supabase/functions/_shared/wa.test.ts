// Rodar: node --experimental-strip-types supabase/functions/_shared/wa.test.ts
import assert from "node:assert/strict";
import { waIdToLocal, localToWa, phoneCanon, parseMessage } from "./wa.ts";

assert.equal(waIdToLocal("5582991212108"), "82991212108");
assert.equal(waIdToLocal("558291212108"), "82991212108"); // sem o 9º dígito
assert.equal(waIdToLocal("558232211234"), "8232211234"); // fixo fica como está
assert.equal(localToWa("82991212108"), "5582991212108");
assert.equal(localToWa("(82) 99121-2108"), "5582991212108");
assert.equal(phoneCanon("5582991212108"), phoneCanon("558291212108"));
assert.equal(phoneCanon("123"), null);
assert.deepEqual(parseMessage({ type: "text", text: { body: "oi" } }), { type: "text", content: "oi", mediaId: null, mime: null });
assert.deepEqual(parseMessage({ type: "audio", audio: { id: "m1", mime_type: "audio/ogg" } }), { type: "audio", content: "[áudio]", mediaId: "m1", mime: "audio/ogg" });
assert.equal(parseMessage({ type: "image", image: { id: "m2", caption: "foto" } }).content, "foto");
assert.equal(parseMessage({ type: "button", button: { text: "Sim" } }).type, "text");
console.log("wa.ts ok");
