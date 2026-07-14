export function formatCurrency(v: number | string | null | undefined): string {
  const n = typeof v === "string" ? parseFloat(v) : v ?? 0;
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(Number.isFinite(n as number) ? (n as number) : 0);
}

export function formatPhoneDisplay(raw?: string | null): string {
  const d = String(raw ?? "").replace(/\D/g, "");
  const local = d.startsWith("55") && d.length >= 12 ? d.slice(2) : d;
  if (local.length === 11)
    return `(${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`;
  if (local.length === 10)
    return `(${local.slice(0, 2)}) ${local.slice(2, 6)}-${local.slice(6)}`;
  return raw ?? "";
}

export function waLink(raw?: string | null): string | null {
  const d = String(raw ?? "").replace(/\D/g, "");
  if (!d) return null;
  return `https://wa.me/${d.startsWith("55") ? d : "55" + d}`;
}

export const MES_FULL = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];
export const MES_ABREV = [
  "jan", "fev", "mar", "abr", "mai", "jun",
  "jul", "ago", "set", "out", "nov", "dez",
];

export function formatDateBR(d?: string | null): string {
  if (!d) return "";
  const iso = String(d).split("T")[0];
  const [y, m, day] = iso.split("-");
  return `${day}/${m}/${y}`;
}
