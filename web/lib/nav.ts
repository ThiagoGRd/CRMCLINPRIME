import {
  LayoutDashboard,
  Filter,
  Users,
  MessagesSquare,
  Workflow,
  CalendarDays,
  BarChart3,
  Heart,
  Link2,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  subtitle: string;
  icon: LucideIcon;
  addLead?: boolean;
  group?: "main" | "ops" | "config";
};

export const NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard Clínico", subtitle: "Visão geral da operação e do comercial", icon: LayoutDashboard, group: "main" },
  { href: "/funil", label: "Funil de Tratamentos", subtitle: "Do lead ao fechamento do orçamento, etapa por etapa", icon: Filter, addLead: true, group: "main" },
  { href: "/pacientes", label: "Pacientes", subtitle: "Base de leads e pacientes da clínica", icon: Users, addLead: true, group: "main" },
  { href: "/inbox", label: "Multiatendimento", subtitle: "Central de conversas de WhatsApp e Instagram", icon: MessagesSquare, group: "ops" },
  { href: "/automacoes", label: "Automações", subtitle: "Fluxos e gatilhos automáticos", icon: Workflow, group: "ops" },
  { href: "/agenda", label: "Agenda Clínica", subtitle: "Consultas sincronizadas com o Clinicorp", icon: CalendarDays, group: "ops" },
  { href: "/metas", label: "Metas & Vendas", subtitle: "Resultados do funil e financeiro por período", icon: BarChart3, group: "ops" },
  { href: "/followup", label: "Follow-up", subtitle: "Resgate de orçamentos em aberto e faltas", icon: Heart, group: "ops" },
  { href: "/conexoes", label: "Conexões", subtitle: "Canais de WhatsApp e Instagram conectados", icon: Link2, group: "config" },
];

export function navByHref(pathname: string): NavItem | undefined {
  return NAV.find((n) => pathname === n.href || pathname.startsWith(n.href + "/"));
}
