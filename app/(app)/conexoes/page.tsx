import { redirect } from "next/navigation";

export default function ConexoesPage() {
  redirect("/configuracoes?aba=conexoes");
}
