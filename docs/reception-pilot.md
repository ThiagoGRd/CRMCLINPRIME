# Recepção: piloto de texto

Este código acrescenta ao Inbox um painel separado de teste da Recepção e navegação móvel entre conversas, conversa e detalhes. O envio e os controles de IA já existentes no Inbox permanecem separados.

O piloto não é uma caixa de atendimento completa. Ele aceita somente texto de até 1024 bytes para um destino fixo aprovado, independentemente do paciente aberto. Não importa mensagens recebidas, não grava histórico no CRM e não habilita outras caixas ou canais.

O painel permanece indisponível sem configuração completa e autorização válida. Publicar este código, por si só, não ativa o piloto. Esta entrega contém a interface e as rotas da aplicação; a integração externa necessária não está incluída.

## Uso do painel habilitado

- Confira o destino fixo exibido antes de usar **Enviar teste**.
- Se o resultado ficar pendente ou incerto, use **Consultar estado (sem reenviar)**. Não repita o envio.
- **API aceitou** não confirma entrega nem leitura.
- Uma nova tentativa exige **Criar nova mensagem explicitamente**, quando disponível.

## Testes locais

Com Node.js 24 e as dependências do projeto instaladas:

```sh
node --require ./tests/register.cjs --test tests/*.test.mjs tests/*.test.ts tests/*.test.tsx tests/*.test.cjs
```

Esses testes usam dados fictícios e substitutos locais das integrações. Eles verificam o código da aplicação, não a instalação ou o funcionamento de serviços externos.
