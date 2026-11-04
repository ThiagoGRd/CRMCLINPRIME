# Janela de atendimento e templates de texto

## Regras implementadas

A migração `20261103070000_whatsapp_window_templates.sql` aplica a janela no servidor, dentro do claim serializado por UUID. A consulta usa somente a última `crm_messages.created_at` de direção `inbound`, com a mesma organização, paciente, conversa e canal. Atividade outbound, outro número, histórico sem canal, ausência de entrada, horário futuro e limite exato de 24 horas não abrem a janela. A interface é informativa, nunca a autoridade.

Uma intenção nova de texto fora da janela fica `failed` com `failure_code: outside_service_window`, sem despacho. A rejeição é durável e consultável. O mesmo UUID não pode passar a enviar depois que chegar uma nova mensagem. Tentativas já ocupadas conservam seu resultado, mesmo se a janela expirar. A serialização e os tombstones da migração 600 continuam valendo.

Templates passam pela mesma identidade durável. `message_kind` e `template_payload` são imutáveis, além de usuário, organização, rota e prévia textual. Mudar nome, idioma, parâmetros ou tipo com o mesmo UUID gera conflito. A confirmação tardia e a reconciliação persistem o conteúdo original com `message_type: template`, sem novo envio.

## Catálogo e prévia

`POST whatsapp-templates` recebe `conversation_id` e `channel_id`, autentica a sessão, valida participação na organização e a rota conectada/classificada. Retorna `templates`, `window` e `checked_at`. `action: window` retorna apenas a janela local, sem ler credenciais nem consultar Meta.

O catálogo lê `/{WABA_ID}/phone_numbers` para verificar que o número pertence ao WABA configurado e `/{WABA_ID}/message_templates` para obter a aprovação atual. Os segredos permanecem no servidor. Todas as consultas usam GET, timeout e redirecionamentos desabilitados. Paginação aceita somente cursores e reconstrói URLs na origem esperada; resultado incompleto, paginação inválida, duplicidade ambígua, ausência de credenciais/WABA, falha de permissão ou de metadados bloqueiam o catálogo. Não existe catálogo de exemplo ou fallback desatualizado.

O escopo suportado é intencionalmente menor que a API Meta:

- Status exatamente `APPROVED`, categoria `UTILITY` ou `MARKETING`, nome e idioma exatos.
- BODY textual obrigatório, HEADER `TEXT` opcional e FOOTER estático opcional.
- Variáveis posicionais contíguas `{{1}}`, `{{2}}`, com no máximo uma no header e 20 no body.
- Variáveis devem ser strings não vazias, sem caracteres de controle/quebras de linha. A prévia final tem limite conservador de 60 caracteres no header e 1024 no body; footer até 60. Esses são limites do produto, não uma promessa de suportar todos os limites da Meta.
- Mídia, botões, carrossel, autenticação/OTP, variáveis nomeadas, componentes desconhecidos e funcionalidades desconhecidas dentro dos componentes são rejeitados, sem conversão silenciosa para texto.

Para enviar, a interface deve mostrar a prévia completa e exigir um clique explícito. A requisição é `{request_id,conversation_id,channel_id,kind:'template',template:{name,language,header:string[],body:string[],preview:string}}`. O servidor relê o catálogo no envio, valida os parâmetros, renderiza a mesma prévia e compara com a confirmação. Alterações exigem nova revisão. Não cria, edita nem submete templates para aprovação.

## Fontes primárias verificadas em 3/11/2026

- [WhatsApp Business Messaging Policy](https://whatsappbusiness.com/policy/), atualização de 23/9/2026: a janela de 24h abre e reinicia a cada mensagem do usuário; fora dela exige template aprovado. A política também exige opt-in e respeito ao opt-out.
- [Workspace oficial Meta no Postman](https://www.postman.com/meta/whatsapp-business-platform/overview), identificação da coleção oficial.
- [Meta: Fetch Message Templates](https://www.postman.com/meta/whatsapp-business-platform/request/f7o759z/fetch-message-templates), catálogo por WABA.
- [Meta: mensagens](https://www.postman.com/meta/whatsapp-business-platform/folder/o48mro7/messages), envio por Phone Number ID e permissão `whatsapp_business_messaging`.
- [WhatsApp: gerenciamento de templates](https://whatsappbusiness.com/blog/manage-message-templates-whatsapp-business-api/), estrutura de header/body/footer e parâmetros textuais. O exemplo antigo de versão não foi usado para mudar a versão Graph 25 já adotada pelo projeto.

As páginas principais em developers.facebook.com retornaram HTTP429 na pesquisa. A política atual e a coleção oficial Meta foram consultadas como fontes primárias alternativas.

## Verificação e limites de operação

Testes totalmente sintéticos cobrem limites de 24h, isolamento de canal, timestamp futuro, rejeição durável, vínculo do UUID com payload, reconciliação sem transporte, catálogo e paginação, identidade WABA/número, aprovação, formas suportadas, parâmetros e prévia. O endpoint é executado em harness com transporte falso; o SQL real roda em PGlite.

Nenhuma credencial foi lida, criada ou alterada neste desenvolvimento. Nenhuma chamada de provedor autenticada, mensagem real, criação de template, migração remota, commit, push ou deploy foi realizado. A existência de WABA, permissões válidas, templates aprovados e opt-in operacional **não foi verificada ao vivo**. Sem metadados válidos o recurso bloqueia, não finge estar pronto.

Antes de produção, revisar o esquema predecessor real/sanitizado, inclusive a aceitação de `message_type: template`, aplicar a cadeia de migrações em staging autorizado e validar permissões de leitura de templates/telefone do token existente. Testar concorrência PostgreSQL/Edge e comportamento Meta com número de teste autorizado. A aprovação pode mudar entre leitura e dispatch; uma rejeição do provedor segue terminal, sem retry automático. O sistema não comprova opt-in nem substitui políticas de consentimento e tratamento de dados da clínica.

O webhook agora rejeita timestamp inbound ausente, inválido, fracionário, zero ou futuro antes de criar paciente/deal/mensagem. Retorna erro recuperável de ingestão, sem fabricar `created_at` com o horário de processamento. Isso evita que um evento malformado conceda 24h indevidamente. Entradas legadas já persistidas com horários artificiais precisam de revisão em staging; não houve reparo ou recálculo automático.
