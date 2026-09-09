import Link from "next/link";
import styles from "@/components/saga-draft-pattern-handoff-link.module.css";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * A small route-level bridge, intentionally outside ContentStudio itself.
 * It never reads a draft or creates state: the protected handoff page does
 * that after the author consciously opens it.
 */
export function SagaDraftPatternHandoffLink({ draftId }: { draftId: string }) {
  if (!uuidPattern.test(draftId)) return null;
  return (
    <aside className={styles.handoff} aria-label="Bygg ett återkommande mönster från utkastet">
      <div className={styles.mark} aria-hidden="true">✦</div>
      <div>
        <p>FRÅN UTKAST TILL MÖNSTER</p>
        <strong>När den här riktningen sitter kan du göra den återanvändbar.</strong>
        <span>Frys utkastet som referens, testa med AI och spara en pausad automation — i rätt ordning.</span>
      </div>
      <Link href={`/studio/content/${encodeURIComponent(draftId)}/pattern`}>Bygg mönster <span aria-hidden="true">→</span></Link>
    </aside>
  );
}
