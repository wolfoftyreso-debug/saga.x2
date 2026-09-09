import { AppShell } from "@/components/app-shell";
import { SagaContentCalendar } from "@/components/saga-content-calendar";

export const dynamic = "force-dynamic";

export default function StudioCalendarPage() {
  return <AppShell><SagaContentCalendar /></AppShell>;
}
