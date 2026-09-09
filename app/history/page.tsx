import { redirect } from "next/navigation";

/** Legacy link retained for existing bookmarks. */
export default function HistoryPage() {
  redirect("/briefs");
}
