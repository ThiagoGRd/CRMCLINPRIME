/* ==========================================================================
   Apex Odonto CRM — Evolution API Service
   Wrapper para enviar/receber mensagens WhatsApp via Evolution API
   ========================================================================== */

const EVOLUTION_URL = process.env.EVOLUTION_API_URL || 'http://localhost:8080';
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY || '';
const INSTANCE_NAME = process.env.EVOLUTION_INSTANCE_NAME || 'apex-odonto';

/**
 * Faz requisições autenticadas para a Evolution API
 */
async function evolutionFetch(path, options = {}) {
  const url = `${EVOLUTION_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      apikey: EVOLUTION_KEY,
      ...options.headers,
    },
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => 'Unknown error');
    throw new Error(`Evolution API error [${res.status}]: ${errorBody}`);
  }

  return res.json();
}

/**
 * Envia mensagem de texto via WhatsApp
 * @param {string} phone — Número com DDI (ex: "5511999999999")
 * @param {string} text — Texto da mensagem
 */
export async function sendTextMessage(phone, text) {
  return evolutionFetch(`/message/sendText/${INSTANCE_NAME}`, {
    method: 'POST',
    body: JSON.stringify({
      number: phone.replace(/\D/g, ''),
      text,
    }),
  });
}

/**
 * Envia mensagem com mídia (imagem, documento, etc.)
 * @param {string} phone — Número com DDI
 * @param {string} mediaUrl — URL pública do arquivo
 * @param {string} caption — Legenda opcional
 * @param {string} mediatype — 'image' | 'document' | 'audio' | 'video'
 */
export async function sendMediaMessage(phone, mediaUrl, caption = '', mediatype = 'image') {
  return evolutionFetch(`/message/sendMedia/${INSTANCE_NAME}`, {
    method: 'POST',
    body: JSON.stringify({
      number: phone.replace(/\D/g, ''),
      mediatype,
      media: mediaUrl,
      caption,
    }),
  });
}

/**
 * Verifica o status da conexão do WhatsApp
 */
export async function getConnectionStatus() {
  try {
    const data = await evolutionFetch(`/instance/connectionState/${INSTANCE_NAME}`, {
      method: 'GET',
    });
    return { connected: data?.state === 'open', state: data?.state, instance: INSTANCE_NAME };
  } catch (err) {
    return { connected: false, state: 'error', error: err.message, instance: INSTANCE_NAME };
  }
}

/**
 * Obtém o QR Code para conectar o WhatsApp
 */
export async function getQrCode() {
  return evolutionFetch(`/instance/connect/${INSTANCE_NAME}`, {
    method: 'GET',
  });
}

/**
 * Cria uma nova instância na Evolution API
 */
export async function createInstance(instanceName = INSTANCE_NAME) {
  return evolutionFetch('/instance/create', {
    method: 'POST',
    body: JSON.stringify({
      instanceName,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
    }),
  });
}

/**
 * Lista todas as instâncias
 */
export async function listInstances() {
  return evolutionFetch('/instance/fetchInstances', { method: 'GET' });
}

export default {
  sendTextMessage,
  sendMediaMessage,
  getConnectionStatus,
  getQrCode,
  createInstance,
  listInstances,
};
