import 'server-only';
import {configuredReceptionPilot} from './reception-pilot-configured';
import {createReceptionPilotHandlers} from './reception-pilot';
import {rejectDuplicateJsonKeys} from './reception-gateway-client';

const CONFIG_KEYS = [
  'vercelProjectId', 'appOrigin', 'orgId', 'actorId', 'channelId',
  'recipientBindingId', 'principal', 'recipientLabel', 'revision',
] as const;

/** Server-only, deliberately configured Production runtime. No request, browser
 * value, public variable or generic gateway flag can supply its authority.
 * Bind once per deployment/process; configuration changes require a redeploy.
 */
function createRuntime() {
  try {
    if (typeof window !== 'undefined' || process.env.NODE_ENV !== 'production' ||
        process.env.VERCEL !== '1' || process.env.VERCEL_ENV !== 'production' ||
        process.env.VERCEL_TARGET_ENV !== 'production' ||
        process.env.CRM_RECEPTION_PILOT_ENABLED !== 'true') {
      return createReceptionPilotHandlers();
    }

    const raw = process.env.CRM_RECEPTION_PILOT_CONFIG;
    const token = process.env.CRM_RECEPTION_GATEWAY_TOKEN;
    if (!raw || !token || Buffer.byteLength(raw, 'utf8') > 4096) throw Error();
    rejectDuplicateJsonKeys(raw);
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error();
    const value = parsed as Record<string, unknown>;
    if (Object.keys(value).length !== CONFIG_KEYS.length ||
        !CONFIG_KEYS.every(key => Object.hasOwn(value, key) && typeof value[key] === 'string' && value[key].length > 0)) throw Error();
    const config = value as Record<typeof CONFIG_KEYS[number], string>;
    if (!/^prj_[A-Za-z0-9]{1,64}$/.test(config.vercelProjectId) ||
        config.vercelProjectId !== process.env.VERCEL_PROJECT_ID ||
        config.appOrigin !== 'https://crmclinprime.vercel.app' ||
        config.recipientLabel !== config.recipientLabel.trim() ||
        /[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(config.recipientLabel)) throw Error();

    // The existing factory validates UUIDs, canonical HTTPS app origin, bounded
    // label/revision/principal and credential before any session/network call.
    // This origin has no path: the client appends /crm-recepcao/v1/... itself.
    return configuredReceptionPilot({
      origin: 'https://evolution.clinprime.shop', token,
      appOrigin: config.appOrigin, orgId: config.orgId, actorId: config.actorId,
      channelId: config.channelId, recipientBindingId: config.recipientBindingId,
      principal: config.principal, recipientLabel: config.recipientLabel, revision: config.revision,
    });
  } catch {
    // Never log/return config, credentials, parsing failures or infrastructure details.
    return createReceptionPilotHandlers();
  }
}

export const receptionPilotRuntime = createRuntime();
