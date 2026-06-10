/* ==========================================================================
   Apex Odonto CRM — Workflow Importer para n8n
   Importa automaticamente os templates de automação na API pública do n8n
   ========================================================================== */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';

// Obter argumentos
const n8nUrlArg = process.argv.find(arg => arg.startsWith('--url='));
const n8nUrl = n8nUrlArg ? n8nUrlArg.split('=')[1] : (process.env.N8N_WEBHOOK_BASE_URL?.replace('/webhook', '') || 'http://localhost:5678');
const apiKey = process.env.N8N_API_KEY;

if (!apiKey) {
  console.error('❌ N8N_API_KEY não foi encontrada no arquivo .env.');
  process.exit(1);
}

const workflowsDir = path.resolve('./n8n-workflows');
if (!fs.existsSync(workflowsDir)) {
  console.error(`❌ Diretório de workflows não encontrado: ${workflowsDir}`);
  process.exit(1);
}

console.log(`🤖 Iniciando importador de workflows para o n8n...`);
console.log(`🔗 URL de destino do n8n: ${n8nUrl}`);
console.log(`📂 Lendo diretório: ${workflowsDir}\n`);

async function importWorkflow(fileName) {
  const filePath = path.join(workflowsDir, fileName);
  const rawData = fs.readFileSync(filePath, 'utf8');
  
  let workflowData;
  try {
    workflowData = JSON.parse(rawData);
  } catch (err) {
    console.error(`❌ Erro ao ler JSON de ${fileName}:`, err.message);
    return;
  }

  // Garantir que o workflow seja importado como ativo
  workflowData.active = true;

  console.log(`⏳ Importando "${workflowData.name}"...`);

  try {
    const res = await fetch(`${n8nUrl}/api/v1/workflows`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-N8N-API-KEY': apiKey
      },
      body: JSON.stringify(workflowData)
    });

    const result = await res.json();

    if (res.ok) {
      console.log(`✅ Sucesso! Workflow "${workflowData.name}" importado e ativado. ID no n8n: ${result.id}`);
    } else {
      // Se já existir, a API pode retornar erro, vamos tentar dar UPDATE se o erro indicar isso,
      // ou apenas avisar
      console.error(`⚠️ Falha ao criar "${workflowData.name}" [Status ${res.status}]:`, result.message || JSON.stringify(result));
    }
  } catch (err) {
    console.error(`❌ Erro de rede ao conectar com o n8n em ${n8nUrl}:`, err.message);
  }
}

async function run() {
  const files = fs.readdirSync(workflowsDir).filter(f => f.endsWith('.json'));
  
  if (files.length === 0) {
    console.log('⚠️ Nenhum arquivo de workflow JSON encontrado.');
    return;
  }

  for (const file of files) {
    await importWorkflow(file);
    console.log('---');
  }

  console.log('🏁 Processo de importação finalizado.');
}

run().catch(err => {
  console.error('❌ Erro fatal:', err);
});
