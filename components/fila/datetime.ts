// Valor de <input type="datetime-local"> (hora local do navegador) -> ISO, ou null se vazio/inválido.
export function localToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
