import {
  ListChecks,
  MessagesSquare,
  Users,
  CalendarDays,
  Filter,
  Workflow,
  BarChart3,
  Settings,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  subtitle: string;
  icon: LucideIcon;
  addLead?: boolean;
  badge?: "overdue";
  group?: "main" | "ops" | "config";
};

export const NAV: NavItem[] = [
  { href: "/fila", label: "Minha fila", subtitle: "O que fazer agora, por prazo", icon: ListChecks, badge: "overdue", group: "main" },
  { href: "/inbox", label: "Conversas", subtitle: "Central de conversas de WhatsApp e Instagram", icon: MessagesSquare, group: "main" },
  { href: "/pacientes", label: "Pacientes", subtitle: "Base de leads e pacientes da clínica", icon: Users, addLead: true, group: "main" },
  { href: "/agenda", label: "Agenda", subtitle: "Consultas sincronizadas com o Clinicorp", icon: CalendarDays, group: "main" },
  { href: "/funil", label: "Funil", subtitle: "Do lead ao fechamento do orçamento, etapa por etapa", icon: Filter, addLead: true, group: "main" },
  { href: "/automacoes", label: "Cadências", subtitle: "Fluxos e gatilhos automáticos", icon: Workflow, group: "ops" },
  { href: "/gestao", label: "Gestão", subtitle: "Visão geral, metas e ROI por origem", icon: BarChart3, group: "ops" },
  { href: "/configuracoes", label: "Configurações", subtitle: "Organização, funil, equipe e conexões", icon: Settings, group: "config" },
];

export function navByHref(pathname: string): NavItem | undefined {
  return NAV.find((n) => pathname === n.href || pathname.startsWith(n.href + "/"));
}

// Estado do menu móvel: guarda a rota em que abriu e zera ao navegar, para que voltar à rota original não o reabra.
export function nextMenuOpenAt(openAt: string | null, pathname: string): string | null {
  return openAt !== null && openAt !== pathname ? null : openAt;
}
