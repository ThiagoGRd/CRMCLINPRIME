import { execSync } from 'child_process';
import path from 'path';

console.log('🤖 Iniciando instalação de dependências...');
const npmCliPath = '/Users/thiagocruz/.hermes/node/lib/node_modules/npm/bin/npm-cli.js';

try {
  execSync(`node "${npmCliPath}" install`, {
    cwd: path.resolve('.'),
    stdio: 'inherit'
  });
  console.log('✅ Dependências instaladas com sucesso!');
} catch (err) {
  console.error('❌ Erro ao executar instalação:', err.message);
  process.exit(1);
}
