import { AppShell } from "@/components/app-shell";
import { ContentStudio } from "@/components/content-studio";

export const dynamic = "force-dynamic";

export default function StudioTemplatesPage() {
  return <AppShell><ContentStudio route="templates" /></AppShell>;
}
