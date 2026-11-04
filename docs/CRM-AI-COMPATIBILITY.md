# Controle de atendimento: compatibilidade com a IA existente

## O que existia

No baseline `7d3c483`, `components/inbox/inbox-client.tsx` consultava `chats.ai_service` pelo prefixo do telefone do paciente e pegava somente a primeira linha. A alternância atualizava **todas** as linhas correspondentes ao prefixo, sem filtrar organização, conversa ou número de atendimento. A interface mostrava sucesso mesmo quando nenhuma linha era alterada. Ausência de registro era interpretada como IA ativa.

O cliente de `legacy/js/api-client.js` usa `pause` para assumir e `active` para devolver. O componente do baseline usa `pause` e `ativo`. Essa diferença não prova qual valor o consumidor real aceita. Os workflows versionados não contêm o consumidor WF01/Sofia nem o esquema completo de `chats`; portanto não permitem comprovar o contrato, a identidade ou o efeito de uma escrita.

Restaurar a escrita por prefixo violaria a separação de Recepção, Comercial e CRC. Também seria incorreto expor um botão que só muda o estado no navegador e afirma que a automação foi pausada.

## Estratégia de compatibilidade proposta

1. **Reutilizar a automação existente.** Não instalar agente, pedir credenciais, criar supervisão, refazer onboarding nem trocar a integração. Primeiro revisar uma cópia autorizada e sanitizada do esquema `chats` e do consumidor existente para identificar sua chave estável, organização, identidade exata da instância/número de origem e valores de pausa/retomada realmente aceitos.
2. **Vincular identidade comprovada.** Usar a chave estável do chat vinculada a `(org_id, patient_id, channel_id)` e à identidade do provedor. Se o legado já contém essas chaves, reutilizá-las. Caso contrário, uma ponte mínima com vínculos únicos e chaves estrangeiras compostas pode ser necessária. O vínculo deve vir da ingestão com identidade verificada; não de prefixo de telefone, escolha da primeira linha ou igualdade de telefone sem número de origem.
3. **Uma operação transacional e autorizada.** Uma RPC específica recebe `conversation_id`, estado desejado e versão esperada; valida o membro da organização, a conversa, o vínculo e a versão, e altera exatamente uma linha existente de `chats` pela chave primária e escopo verificado. Zero ou múltiplas correspondências, vínculo ausente, versão desatualizada ou valor desconhecido devem falhar sem escrita. Registrar ator, conversa, chat vinculado, estado anterior/novo e horário. Não executar uma atualização ampla nem criar um chat por suposição.
4. **Não prometer um efeito não confirmado.** O cliente deve mostrar estados distintos: controle indisponível sem vínculo; status desconhecido se a leitura falhar; pausa/retomada solicitada ou estado salvo quando somente a persistência é verificável. Só afirmar que a IA parou/voltou quando o consumidor existente confirmar esse efeito ou seu contrato comprovado garantir a consulta do estado antes da resposta. Não inferir atividade da ausência de registro.
5. **Provar isolamento antes de habilitar.** Testar dois números para o mesmo paciente, mesmo telefone em organizações diferentes, prefixos coincidentes, registro ausente, vínculo duplicado, usuário sem acesso, versão concorrente e falha do consumidor. Conferir os valores exatos `active`/`ativo` sem tentar ambos contra produção. A retomada não deve disparar mensagem por conta própria.

## Limite desta alteração

Nenhuma escrita em `chats`, RPC de controle de IA ou integração nova foi implementada. Não há esquema/consumidor versionado suficiente para garantir que uma restauração preserve o destinatário e o efeito. O novo fluxo “Abrir conversa” apenas cria ou encontra a conversa CRM e nunca envia mensagens nem altera IA.
