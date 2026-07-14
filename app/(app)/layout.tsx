import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getMyOrg } from "@/lib/org";
import { OrgProvider } from "@/components/org-context";
import { AppShell } from "@/components/app-shell";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const org = await getMyOrg(supabase);
  if (!org) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-8 text-center text-muted-foreground">
        Sua conta ainda não está vinculada a uma organização.
      </div>
    );
  }

  return (
    <OrgProvider org={org}>
      <AppShell userEmail={user.email ?? ""}>{children}</AppShell>
    </OrgProvider>
  );
}
