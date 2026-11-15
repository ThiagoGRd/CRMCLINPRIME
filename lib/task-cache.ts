// Um único ponto para invalidar tudo que mostra tarefas: fila/menu, "sem próxima ação" e o painel do paciente.
export function invalidateTaskCaches(qc: { invalidateQueries: (f: { queryKey: unknown[] }) => unknown }, orgId: string): void {
  void qc.invalidateQueries({ queryKey: ["tasks", orgId] });
  void qc.invalidateQueries({ queryKey: ["forgotten", orgId] });
  void qc.invalidateQueries({ queryKey: ["patient-tasks"] });
}
