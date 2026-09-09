import { AppShell } from "@/components/app-shell";
import { SagaPreviewGallery, type SagaPreviewImageAssets } from "@/components/saga-preview-gallery";

/**
 * A deterministic, non-persistent example gallery. This route is deliberately
 * separate from a real draft preview: it owns no workspace data, write,
 * delivery, schedule or publication action.
 */
export const dynamic = "force-static";

const SAGA_PREVIEW_IMAGES: SagaPreviewImageAssets = {
  instagram: "/demo/saga/automation-human-work-v1.png",
  linkedin: "/demo/saga/automation-human-work-v1.png",
  newsletter: "/demo/saga/automation-human-work-v1.png",
  article: "/demo/saga/automation-human-work-v1.png",
  family: "/demo/saga/automation-human-work-v1.png",
};

export default function PreviewPage() {
  return <AppShell><SagaPreviewGallery images={SAGA_PREVIEW_IMAGES} /></AppShell>;
}
