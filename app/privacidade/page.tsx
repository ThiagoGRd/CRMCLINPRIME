import type { Metadata } from "next";

export const metadata: Metadata = { title: "Política de Privacidade — ClinPrime" };

// Página pública (exigida pela Meta para publicar o app do WhatsApp).
export default function PrivacidadePage() {
  return (
    <main className="mx-auto max-w-2xl space-y-5 px-4 py-12 text-sm leading-relaxed">
      <h1 className="font-heading text-2xl font-bold">Política de Privacidade</h1>
      <p className="text-muted-foreground">Última atualização: 3 de novembro de 2026</p>

      <p>
        Esta política descreve como a ClinPrime trata os dados pessoais de pacientes e interessados que entram em
        contato com a clínica, inclusive pelo WhatsApp, em conformidade com a Lei Geral de Proteção de Dados (Lei
        13.709/2018 — LGPD).
      </p>

      <h2 className="font-heading text-lg font-semibold">Dados que coletamos</h2>
      <p>
        Nome, número de telefone, mensagens trocadas com a clínica, informações de agendamento e de orçamento, e os
        dados que você nos enviar voluntariamente durante o atendimento.
      </p>

      <h2 className="font-heading text-lg font-semibold">Para que usamos</h2>
      <p>
        Para responder ao seu contato, agendar e confirmar consultas, enviar orçamentos e lembretes, e acompanhar o seu
        atendimento. Não vendemos nem compartilhamos seus dados para fins de publicidade de terceiros.
      </p>

      <h2 className="font-heading text-lg font-semibold">Com quem compartilhamos</h2>
      <p>
        Somente com fornecedores necessários para operar o atendimento: Meta (WhatsApp Business Platform), para troca
        de mensagens; Supabase, para armazenamento seguro dos dados; e o sistema de gestão da clínica (Clinicorp), para
        agenda e orçamentos.
      </p>

      <h2 className="font-heading text-lg font-semibold">Por quanto tempo guardamos</h2>
      <p>
        Pelo tempo necessário ao atendimento e às obrigações legais e regulatórias aplicáveis a serviços de saúde.
      </p>

      <h2 className="font-heading text-lg font-semibold">Seus direitos</h2>
      <p>
        Você pode pedir acesso, correção, portabilidade ou exclusão dos seus dados, e revogar consentimentos, a qualquer
        momento, enviando uma mensagem para o WhatsApp da clínica.
      </p>

      <h2 className="font-heading text-lg font-semibold">Segurança</h2>
      <p>
        Os dados ficam em servidores com acesso restrito à equipe da clínica, protegidos por autenticação e controle de
        acesso por organização.
      </p>
    </main>
  );
}
