// Embedded Signup da Meta em modo coexistência (o número continua no app WhatsApp Business).
// IDs públicos do app "ClinPrime CRM" e da configuração de Login para Empresas.
export const META_APP_ID = "1807826200432927";
export const WA_ES_CONFIG_ID = "1135779666023190";

type FBLoginResponse = { authResponse?: { code?: string } | null; status?: string };
type FBSdk = {
  init: (o: Record<string, unknown>) => void;
  login: (cb: (r: FBLoginResponse) => void, o: Record<string, unknown>) => void;
};
declare global {
  interface Window { FB?: FBSdk; fbAsyncInit?: () => void }
}

let sdkPromise: Promise<FBSdk> | null = null;

function loadSdk(): Promise<FBSdk> {
  if (window.FB) return Promise.resolve(window.FB);
  sdkPromise ??= new Promise((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB!.init({ appId: META_APP_ID, autoLogAppEvents: true, xfbml: false, version: "v25.0" });
      resolve(window.FB!);
    };
    const s = document.createElement("script");
    s.src = "https://connect.facebook.net/pt_BR/sdk.js";
    s.async = true;
    s.crossOrigin = "anonymous";
    s.onerror = () => { sdkPromise = null; reject(new Error("não foi possível carregar o SDK da Meta")); };
    document.body.appendChild(s);
  });
  return sdkPromise;
}

/** Abre o popup da Meta. Resolve com o code (trocado por token no backend) e o waba_id, se o evento chegou. */
export async function launchWhatsAppSignup(): Promise<{ code: string; wabaId: string | null }> {
  const FB = await loadSdk();
  let wabaId: string | null = null;
  let cancelled = false;

  const onMessage = (event: MessageEvent) => {
    if (!event.origin.endsWith("facebook.com")) return;
    try {
      const d = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      if (d?.type !== "WA_EMBEDDED_SIGNUP") return;
      if (d.event === "CANCEL") cancelled = true;
      else if (d.data?.waba_id) wabaId = String(d.data.waba_id);
    } catch { /* mensagens de outros scripts do Facebook */ }
  };
  window.addEventListener("message", onMessage);

  try {
    const code = await new Promise<string>((resolve, reject) => {
      FB.login((r) => {
        if (r.authResponse?.code) resolve(r.authResponse.code);
        else reject(new Error(cancelled ? "Conexão cancelada" : "Login na Meta não concluído"));
      }, {
        config_id: WA_ES_CONFIG_ID,
        response_type: "code",
        override_default_response_type: true,
        extras: { setup: {}, featureType: "whatsapp_business_app_onboarding", sessionInfoVersion: "3" },
      });
    });
    // O evento com o waba_id pode chegar logo depois do callback.
    if (!wabaId) await new Promise((r) => setTimeout(r, 1500));
    return { code, wabaId };
  } finally {
    window.removeEventListener("message", onMessage);
  }
}
