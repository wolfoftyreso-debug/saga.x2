"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { upload } from "@vercel/blob/client";
import styles from "@/components/saga-avatar-references-workspace.module.css";

type AvatarLoadState = "loading" | "ready" | "unavailable";
type AvatarSaveState = "idle" | "saving" | "deleting" | "error";

export type AvatarReferenceAngle = "front" | "three_quarter_left" | "three_quarter_right" | "left_profile" | "right_profile" | "back" | "other";

export type SagaAvatarReference = {
  id: string;
  angle: AvatarReferenceAngle;
  position: number;
  createdAt: string | null;
};

export type SagaAvatarProfile = {
  id: string;
  label: string;
  providerProcessing: {
    consented: boolean;
    readyForPrivateModelUse: boolean;
  };
  createdAt: string | null;
  references: SagaAvatarReference[];
};

type SelectedReference = {
  id: string;
  file: File;
  angle: AvatarReferenceAngle;
};

type AvatarResponse = {
  profiles: SagaAvatarProfile[];
};

type AvatarUploadGrantUpload = {
  id: string;
  pathname: string;
  angle: AvatarReferenceAngle;
  contentType: string;
  byteSize: number;
};

type AvatarUploadGrant = {
  grant: string;
  uploads: AvatarUploadGrantUpload[];
};

type PendingAvatarFinalization = {
  profileId: string;
  profileLabel: string;
  grant: string;
  photoCount: number;
};

class AvatarUploadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AvatarUploadRequestError";
  }
}

class AvatarUploadPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AvatarUploadPendingError";
  }
}

export type AvatarUploadRequirements = {
  existingReferenceCount: number;
  minimumFiles: number;
  maximumFiles: number;
};

type SagaAvatarReferencesWorkspaceProps = {
  /** Primarily useful for isolated tests; production uses the actor-scoped route. */
  apiPath?: string;
};

const MAX_REFERENCES = 6;
const MIN_REFERENCES = 3;
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;
const ACCEPTED_FILE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const angleChoices: ReadonlyArray<{ value: AvatarReferenceAngle; label: string; detail: string }> = [
  { value: "front", label: "Framifrån", detail: "Privat referens" },
  { value: "three_quarter_left", label: "3/4 vänster", detail: "Privat referens" },
  { value: "three_quarter_right", label: "3/4 höger", detail: "Privat referens" },
  { value: "left_profile", label: "Vänster profil", detail: "Privat referens" },
  { value: "right_profile", label: "Höger profil", detail: "Privat referens" },
  { value: "back", label: "Bakifrån", detail: "Privat referens" },
  { value: "other", label: "Annan vinkel", detail: "Privat referens" },
];

const angleLabel: Record<AvatarReferenceAngle, string> = Object.fromEntries(
  angleChoices.map((choice) => [choice.value, choice.label]),
) as Record<AvatarReferenceAngle, string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() || fallback : fallback;
}

function nullableText(value: unknown): string | null {
  const result = safeText(value);
  return result || null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

function isAngle(value: unknown): value is AvatarReferenceAngle {
  return value === "front" || value === "three_quarter_left" || value === "three_quarter_right" || value === "left_profile" || value === "right_profile" || value === "back" || value === "other";
}

function providerProcessingFrom(value: unknown): SagaAvatarProfile["providerProcessing"] {
  if (!isRecord(value)) return { consented: false, readyForPrivateModelUse: false };
  return {
    consented: value.consented === true,
    readyForPrivateModelUse: value.readyForPrivateModelUse === true && value.enabled === true,
  };
}

/**
 * Public API data is intentionally narrowed to non-sensitive metadata. In
 * particular, it refuses asset/blob URLs so source photos cannot accidentally
 * become preview images if a server response grows new fields later.
 */
export function avatarReferencesFromPayload(payload: unknown): AvatarResponse | null {
  if (!isRecord(payload)) return null;
  const rawProfiles = Array.isArray(payload.profiles) ? payload.profiles : Array.isArray(payload.avatarProfiles) ? payload.avatarProfiles : null;
  if (!rawProfiles) return null;

  return {
    profiles: rawProfiles.flatMap((candidate): SagaAvatarProfile[] => {
      if (!isRecord(candidate)) return [];
      const id = safeText(candidate.id);
      // Refuse to surface an avatar profile if a server regression weakens the
      // visual privacy policy. The browser must never present a profile as
      // safe when the only permitted output is no longer obscured noir.
      if (!id || candidate.outputVisibilityPolicy !== "obscured_noir_only" || candidate.fullFaceAllowed !== false) return [];
      const referencesCandidate = Array.isArray(candidate.references)
        ? candidate.references
        : Array.isArray(candidate.referenceImages)
          ? candidate.referenceImages
          : [];
      const references = referencesCandidate.flatMap((reference, index): SagaAvatarReference[] => {
        if (!isRecord(reference)) return [];
        const referenceId = safeText(reference.id);
        const angle = reference.angle;
        if (!referenceId || !isAngle(angle)) return [];
        return [{ id: referenceId, angle, position: positiveInteger(reference.position) ?? index + 1, createdAt: nullableText(reference.createdAt ?? reference.created_at) }];
      });
      return [{
        id,
        label: safeText(candidate.label ?? candidate.name, "Namnlös privat referens"),
        providerProcessing: providerProcessingFrom(candidate.providerProcessing ?? candidate.provider_processing),
        createdAt: nullableText(candidate.createdAt ?? candidate.created_at),
        references,
      }];
    }),
  };
}

export function avatarWorkspaceMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback;
  const code = safeText(payload.code);
  if (code === "configuration_required" || code === "configuration_missing" || code === "database_configuration_invalid") {
    return "Privata foton kan sparas när Neon-anslutningen är redo i Vercel.";
  }
  return safeText(payload.error, fallback);
}

/**
 * A first batch needs three angles, while a saved profile can be filled up
 * one image at a time. Keep this calculation client-side as well as server-
 * side so the form never promises a batch the private API will reject.
 */
export function avatarUploadRequirements(existingReferenceCount: number): AvatarUploadRequirements {
  const existing = Number.isInteger(existingReferenceCount)
    ? Math.min(MAX_REFERENCES, Math.max(0, existingReferenceCount))
    : 0;
  const maximumFiles = MAX_REFERENCES - existing;
  return {
    existingReferenceCount: existing,
    minimumFiles: maximumFiles ? Math.max(1, MIN_REFERENCES - existing) : 0,
    maximumFiles,
  };
}

function selectedReferenceMessage(references: SelectedReference[], requirements: AvatarUploadRequirements): string | null {
  if (requirements.maximumFiles === 0) return "Den valda privata referensen har redan sex foton.";
  if (references.length < requirements.minimumFiles) {
    return requirements.minimumFiles === 1
      ? "Välj minst ett foto."
      : `Välj minst ${requirements.minimumFiles} foton från olika vinklar.`;
  }
  if (references.length > requirements.maximumFiles) {
    return requirements.maximumFiles === 1
      ? "Den valda privata referensen har plats för ett foto till."
      : `Den valda privata referensen har plats för ${requirements.maximumFiles} foton till.`;
  }
  const invalidType = references.some(({ file }) => !ACCEPTED_FILE_TYPES.has(file.type));
  if (invalidType) return "Välj JPG, PNG eller WebP-filer.";
  const tooLarge = references.some(({ file }) => file.size > MAX_FILE_SIZE_BYTES);
  if (tooLarge) return "Varje foto får vara högst 20 MB.";
  return null;
}

function referenceSummary(profile: SagaAvatarProfile): string {
  const count = profile.references.length;
  return `${count} ${count === 1 ? "privat referens" : "privata referenser"}`;
}

function defaultAngle(index: number): AvatarReferenceAngle {
  return angleChoices[index % angleChoices.length]?.value ?? "left_profile";
}

function uploadCountHint(requirements: AvatarUploadRequirements, isExistingProfile: boolean): string {
  if (!requirements.maximumFiles) return "Profilen har redan maximalt sex privata foton.";
  if (!isExistingProfile) return "3–6 foton i första uppladdningen";
  if (requirements.minimumFiles === requirements.maximumFiles) {
    return requirements.maximumFiles === 1 ? "Lägg till ett foto" : `Lägg till ${requirements.maximumFiles} foton`;
  }
  return `Lägg till ${requirements.minimumFiles}–${requirements.maximumFiles} foton`;
}

function uploadButtonLabel(requirements: AvatarUploadRequirements, isExistingProfile: boolean): string {
  if (!requirements.maximumFiles) return "Profilen är full";
  if (!isExistingProfile) return "Välj 3–6 foton";
  return requirements.maximumFiles === 1 ? "Välj ett foto" : "Välj fler foton";
}

/**
 * The grant response is deliberately reduced to the values needed to send
 * bytes directly to the private Blob store. Blob URLs are discarded and are
 * never a source for a preview in Studio.
 */
function avatarUploadGrantFromPayload(payload: unknown, selected: SelectedReference[]): AvatarUploadGrant | null {
  if (!isRecord(payload)) return null;
  const grant = safeText(payload.grant);
  const rawUploads = Array.isArray(payload.uploads) ? payload.uploads : null;
  if (!grant || !rawUploads || rawUploads.length !== selected.length) return null;

  const uploads = rawUploads.flatMap((candidate, index): AvatarUploadGrantUpload[] => {
    if (!isRecord(candidate)) return [];
    const reference = selected[index];
    const id = safeText(candidate.id);
    const pathname = safeText(candidate.pathname);
    const contentType = safeText(candidate.contentType).toLowerCase();
    const byteSize = positiveInteger(candidate.byteSize);
    if (!reference || !id || !pathname || !isAngle(candidate.angle) || !byteSize) return [];
    if (candidate.angle !== reference.angle || contentType !== reference.file.type || byteSize !== reference.file.size) return [];
    return [{ id, pathname, angle: candidate.angle, contentType, byteSize }];
  });
  return uploads.length === selected.length ? { grant, uploads } : null;
}

async function requestAvatarUploadGrant(
  apiPath: string,
  profileId: string,
  selected: SelectedReference[],
): Promise<AvatarUploadGrant> {
  const response = await fetch(`${apiPath}/${encodeURIComponent(profileId)}/upload-grant`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      uploadConsent: true,
      files: selected.map((reference) => ({
        angle: reference.angle,
        contentType: reference.file.type,
        byteSize: reference.file.size,
      })),
    }),
    credentials: "same-origin",
    cache: "no-store",
  });
  const payload: unknown = await response.json().catch(() => null);
  const grant = avatarUploadGrantFromPayload(payload, selected);
  if (!response.ok || !grant) {
    throw new AvatarUploadRequestError(avatarWorkspaceMessage(payload, "Kunde inte förbereda den privata bilduppladdningen."));
  }
  return grant;
}

function profileFromAvatarPayload(payload: unknown): SagaAvatarProfile | null {
  return isRecord(payload) && isRecord(payload.profile)
    ? avatarReferencesFromPayload({ profiles: [payload.profile] })?.profiles[0] ?? null
    : null;
}

async function finalizeAvatarUpload(
  apiPath: string,
  profileId: string,
  grant: string,
): Promise<SagaAvatarProfile> {
  // Vercel Blob's private completion callback can take a moment to become
  // visible. Retrying the same short-lived grant is safe and never sends the
  // bytes through a Serverless Function again.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(`${apiPath}/${encodeURIComponent(profileId)}/upload-finalize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant }),
      credentials: "same-origin",
      cache: "no-store",
    });
    const payload: unknown = await response.json().catch(() => null);
    const profile = profileFromAvatarPayload(payload);
    if (response.status === 201 && profile) return profile;
    if (response.status === 202 && isRecord(payload) && payload.pending === true && attempt < 4) {
      const retryAfterMs = typeof payload.retryAfterMs === "number" && Number.isFinite(payload.retryAfterMs)
        ? Math.min(3_000, Math.max(250, payload.retryAfterMs))
        : 1_000;
      await new Promise<void>((resolve) => window.setTimeout(resolve, retryAfterMs));
      continue;
    }
    if (response.status === 202 && isRecord(payload) && payload.pending === true) {
      throw new AvatarUploadPendingError("De privata fotona är överförda och väntar på en sista verifiering. Håll sidan öppen och försök igen om en stund.");
    }
    throw new AvatarUploadRequestError(avatarWorkspaceMessage(payload, "Kunde inte verifiera den privata bilduppladdningen."));
  }
  throw new AvatarUploadPendingError("De privata fotona väntar fortfarande på en sista verifiering. Håll sidan öppen och försök igen om en stund.");
}

async function uploadAvatarGrantBytes(grant: AvatarUploadGrant, selected: SelectedReference[]): Promise<void> {
  const results = await Promise.allSettled(grant.uploads.map(async (entry, index) => {
    const reference = selected[index];
    if (!reference) throw new AvatarUploadRequestError("Bilduppladdningen saknar en privat referens.");
    await upload(entry.pathname, reference.file, {
      access: "private",
      contentType: entry.contentType,
      multipart: reference.file.size > 4 * 1024 * 1024,
      handleUploadUrl: "/api/saga/avatar-upload",
      clientPayload: JSON.stringify({ grant: grant.grant, uploadId: entry.id }),
    });
  }));
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (rejected) {
    throw new AvatarUploadRequestError("Ett privat foto kunde inte överföras. Inget bildskapande har startats.");
  }
}

async function cancelAvatarUpload(apiPath: string, profileId: string, grant: string): Promise<void> {
  const response = await fetch(`${apiPath}/${encodeURIComponent(profileId)}/upload-cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant }),
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    throw new AvatarUploadRequestError(avatarWorkspaceMessage(payload, "Kunde inte städa upp den avbrutna privata bilduppladdningen."));
  }
}

function Icon({ name }: { name: "shield" | "private" | "add" | "arrow" | "trash" | "eyeOff" | "check" | "reload" | "files" | "info" }) {
  if (name === "shield") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3.8 19 6.7v5.1c0 4.4-2.8 7.2-7 8.4-4.2-1.2-7-4-7-8.4V6.7l7-2.9Z" /><path d="m9.1 12.1 1.9 1.9 4-4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  if (name === "private") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="5" y="10.1" width="14" height="10" rx="2.2" /><path d="M8.3 10.1V7.6a3.7 3.7 0 0 1 7.4 0v2.5M12 14v2.2" strokeLinecap="round" /></svg>;
  if (name === "add") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5v14M5 12h14" strokeLinecap="round" /></svg>;
  if (name === "arrow") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h13M13.2 6.8 18.4 12l-5.2 5.2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  if (name === "trash") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5.5 7.2h13M9.3 7.2V5.3h5.4v1.9m-7.8 0 .8 11.1h8.6l.8-11.1M10 10.3v5.4m4 0v-5.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  if (name === "eyeOff") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3.8 3.8 20.2 20.2M10.1 6.1A10.3 10.3 0 0 1 12 6c5.2 0 8.4 4.4 8.4 6s-1.2 3.3-3.2 4.7M7.1 7.2C4.9 8.6 3.6 10.8 3.6 12c0 1.6 3.2 6 8.4 6 1 0 2-.17 2.8-.49M9.5 9.6a3.4 3.4 0 0 0 4.9 4.9" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  if (name === "check") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 12.4 4.3 4.2L19 6.9" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  if (name === "reload") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M19.2 9.1A7.5 7.5 0 1 0 19 15M19.2 4.8v4.3h-4.3" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  if (name === "files") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8.4 5.1h8.3a2.2 2.2 0 0 1 2.2 2.2v10.1a2.2 2.2 0 0 1-2.2 2.2H8.4a2.2 2.2 0 0 1-2.2-2.2V7.3a2.2 2.2 0 0 1 2.2-2.2Z" /><path d="M4.9 16.7H4.3A2.2 2.2 0 0 1 2.1 14.5V5.7a2.2 2.2 0 0 1 2.2-2.2h8.8a2.2 2.2 0 0 1 2.2 2.2v.4M9.8 10h5.6m-5.6 3.7h5.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8.3" /><path d="M12 10.4v5m0-8.2h.01" strokeLinecap="round" /></svg>;
}

export function SagaAvatarReferencesWorkspace({ apiPath = "/api/saga/avatar-profiles" }: SagaAvatarReferencesWorkspaceProps) {
  const fieldId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [profiles, setProfiles] = useState<SagaAvatarProfile[]>([]);
  const [loadState, setLoadState] = useState<AvatarLoadState>("loading");
  const [loadMessage, setLoadMessage] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<AvatarSaveState>("idle");
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [targetProfileId, setTargetProfileId] = useState<string | null>(null);
  const [selectedReferences, setSelectedReferences] = useState<SelectedReference[]>([]);
  const [consented, setConsented] = useState(false);
  const [pendingFinalization, setPendingFinalization] = useState<PendingAvatarFinalization | null>(null);
  const [providerConsentProfileId, setProviderConsentProfileId] = useState<string | null>(null);
  const [providerConsentAccepted, setProviderConsentAccepted] = useState(false);

  const loadProfiles = useCallback(async (signal?: AbortSignal): Promise<boolean> => {
    setLoadState("loading");
    setLoadMessage(null);
    try {
      const response = await fetch(apiPath, { credentials: "same-origin", cache: "no-store", signal });
      const payload: unknown = await response.json().catch(() => null);
      const parsed = avatarReferencesFromPayload(payload);
      if (!response.ok || !parsed) {
        setProfiles([]);
        setLoadState("unavailable");
        setLoadMessage(avatarWorkspaceMessage(payload, "Privata bildreferenser kan inte läsas just nu."));
        return false;
      }
      setProfiles(parsed.profiles);
      setTargetProfileId((current) => current && parsed.profiles.some((profile) => profile.id === current) ? current : null);
      setLoadState("ready");
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return false;
      setProfiles([]);
      setLoadState("unavailable");
      setLoadMessage("Privata bildreferenser kan inte nås just nu. Försök igen.");
      return false;
    }
  }, [apiPath]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => loadProfiles(controller.signal));
    return () => controller.abort();
  }, [loadProfiles]);

  const targetProfile = useMemo(
    () => profiles.find((profile) => profile.id === targetProfileId) ?? null,
    [profiles, targetProfileId],
  );
  const requirements = useMemo(
    () => avatarUploadRequirements(targetProfile?.references.length ?? 0),
    [targetProfile],
  );
  const isCreatingProfile = !targetProfile;
  const selectionMessage = useMemo(
    () => selectedReferenceMessage(selectedReferences, requirements),
    [requirements, selectedReferences],
  );
  const isMutating = saveState === "saving" || saveState === "deleting";
  const isFinalizationPending = pendingFinalization !== null;
  const canChooseFiles = loadState === "ready" && !isMutating && !isFinalizationPending && requirements.maximumFiles > 0;
  const canSave = loadState === "ready"
    && !isMutating
    && !isFinalizationPending
    && (!isCreatingProfile || label.trim().length >= 2)
    && !selectionMessage
    && consented;

  function chooseFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    setSaveMessage(null);
    // Do not silently discard a seventh image. The user can see and remove
    // it, and the same capacity rule is enforced before anything is sent.
    setSelectedReferences(files.map((file, index) => ({
      id: `${file.name}:${file.size}:${file.lastModified}:${index}`,
      file,
      angle: defaultAngle(requirements.existingReferenceCount + index),
    })));
  }

  function removeSelectedReference(id: string) {
    setSelectedReferences((current) => current.filter((reference) => reference.id !== id));
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function updateAngle(id: string, angle: AvatarReferenceAngle) {
    setSelectedReferences((current) => current.map((reference) => reference.id === id ? { ...reference, angle } : reference));
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave) {
      setSaveState("error");
      setSaveMessage(selectionMessage || (isCreatingProfile
        ? "Ge den privata referensen ett namn och bekräfta samtycket först."
        : "Bekräfta samtycket innan privata foton sparas."));
      return;
    }
    setSaveState("saving");
    setSaveMessage(null);

    let createdProfile: SagaAvatarProfile | null = null;
    let grant: AvatarUploadGrant | null = null;
    let profileIdForUpload = targetProfile?.id ?? null;
    let profileLabelForUpload = targetProfile?.label ?? null;
    try {
      let profileForUpload = targetProfile;
      if (!profileForUpload) {
        const profileResponse = await fetch(apiPath, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ label: label.trim(), uploadConsent: true }),
          credentials: "same-origin",
          cache: "no-store",
        });
        const profilePayload: unknown = await profileResponse.json().catch(() => null);
        createdProfile = isRecord(profilePayload) && isRecord(profilePayload.profile)
          ? avatarReferencesFromPayload({ profiles: [profilePayload.profile] })?.profiles[0] ?? null
          : null;
        if (!profileResponse.ok || !createdProfile) {
          setSaveState("error");
          setSaveMessage(avatarWorkspaceMessage(profilePayload, "Referensen kunde inte skapas. Inga foton har sparats."));
          return;
        }
        profileForUpload = createdProfile;
      }
      profileIdForUpload = profileForUpload.id;
      profileLabelForUpload = profileForUpload.label;

      // The server only issues a short-lived, path-bound grant. Bytes travel
      // straight from this browser to private Blob storage, avoiding a
      // Serverless request-size limit and never exposing a Blob URL in UI.
      grant = await requestAvatarUploadGrant(apiPath, profileForUpload.id, selectedReferences);
      await uploadAvatarGrantBytes(grant, selectedReferences);
      const savedProfile = await finalizeAvatarUpload(apiPath, profileForUpload.id, grant.grant);
      setLabel("");
      setSelectedReferences([]);
      setConsented(false);
      setTargetProfileId(savedProfile.id);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setSaveState("idle");
      setSaveMessage(`${selectedReferences.length} ${selectedReferences.length === 1 ? "privat foto sparat" : "privata foton sparade"} i “${savedProfile.label}”. AI-behandling är fortfarande avstängd.`);
      await loadProfiles();
    } catch (error) {
      if (error instanceof AvatarUploadPendingError && grant && profileIdForUpload) {
        setPendingFinalization({
          profileId: profileIdForUpload,
          profileLabel: profileLabelForUpload ?? "den privata referensen",
          grant: grant.grant,
          photoCount: selectedReferences.length,
        });
        setSaveState("idle");
        setSaveMessage(error.message);
        return;
      }
      if (grant && profileIdForUpload) {
        await cancelAvatarUpload(apiPath, profileIdForUpload, grant.grant).catch(() => undefined);
      }
      // The shell was created before any direct Blob transfer could start.
      // It is safe to roll this empty shell back. Once a grant exists, retain
      // the profile for a retry instead of claiming all temporary bytes were
      // immediately deleted.
      if (createdProfile && !grant) {
        await fetch(`${apiPath}/${encodeURIComponent(createdProfile.id)}`, { method: "DELETE", credentials: "same-origin", cache: "no-store" }).catch(() => undefined);
      }
      setSaveState("error");
      setSaveMessage(error instanceof AvatarUploadRequestError
        ? error.message
        : "Filerna kunde inte sparas. Kontrollera anslutningen och försök igen.");
      await loadProfiles();
    }
  }

  async function retryPendingFinalization() {
    if (!pendingFinalization) return;
    setSaveState("saving");
    setSaveMessage(null);
    try {
      const savedProfile = await finalizeAvatarUpload(apiPath, pendingFinalization.profileId, pendingFinalization.grant);
      setTargetProfileId(savedProfile.id);
      setPendingFinalization(null);
      setSaveState("idle");
      setSaveMessage(`${pendingFinalization.photoCount} ${pendingFinalization.photoCount === 1 ? "privat foto är verifierat" : "privata foton är verifierade"} i “${savedProfile.label}”. AI-behandling är fortfarande avstängd.`);
      await loadProfiles();
    } catch (error) {
      if (error instanceof AvatarUploadPendingError) {
        setSaveState("idle");
        setSaveMessage(error.message);
        return;
      }
      setSaveState("error");
      setSaveMessage(error instanceof AvatarUploadRequestError
        ? error.message
        : "Kunde inte kontrollera den privata bilduppladdningen. Försök igen.");
    }
  }

  async function enableProviderProcessing(profile: SagaAvatarProfile) {
    if (!providerConsentAccepted || providerConsentProfileId !== profile.id) return;
    setSaveState("saving");
    setSaveMessage(null);
    try {
      const response = await fetch(`${apiPath}/${encodeURIComponent(profile.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerProcessingConsent: { provider: "vercel_ai_gateway", accepted: true },
        }),
        credentials: "same-origin",
        cache: "no-store",
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setSaveState("error");
        setSaveMessage(avatarWorkspaceMessage(payload, "Det separata samtycket kunde inte sparas."));
        return;
      }
      setProviderConsentAccepted(false);
      setProviderConsentProfileId(null);
      setSaveState("idle");
      setSaveMessage("Samtycket är dokumenterat. Ingen bildkörning har startats; ett framtida kontrollerat bildflöde kräver fortsatt granskning.");
      await loadProfiles();
    } catch {
      setSaveState("error");
      setSaveMessage("Det separata samtycket kunde inte sparas. Försök igen.");
    }
  }

  async function deleteProfile(profile: SagaAvatarProfile) {
    const confirmed = window.confirm(`Ta bort “${profile.label}” och dess privata referenser? Detta går inte att ångra.`);
    if (!confirmed) return;
    setSaveState("deleting");
    setSaveMessage(null);
    try {
      const response = await fetch(`${apiPath}/${encodeURIComponent(profile.id)}`, {
        method: "DELETE",
        credentials: "same-origin",
        cache: "no-store",
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setSaveState("error");
        setSaveMessage(avatarWorkspaceMessage(payload, "Referensen kunde inte tas bort."));
        return;
      }
      setSaveState("idle");
      setSaveMessage("Privat referens borttagen.");
      await loadProfiles();
    } catch {
      setSaveState("error");
      setSaveMessage("Referensen kunde inte tas bort. Försök igen.");
    }
  }

  async function deleteReference(profile: SagaAvatarProfile, reference: SagaAvatarReference) {
    const confirmed = window.confirm(`Ta bort privat referens ${reference.position} från “${profile.label}”? Detta går inte att ångra.`);
    if (!confirmed) return;
    setSaveState("deleting");
    setSaveMessage(null);
    try {
      const response = await fetch(`${apiPath}/${encodeURIComponent(profile.id)}/references/${encodeURIComponent(reference.id)}`, {
        method: "DELETE",
        credentials: "same-origin",
        cache: "no-store",
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setSaveState("error");
        setSaveMessage(avatarWorkspaceMessage(payload, "Referensen kunde inte tas bort."));
        return;
      }
      setSaveState("idle");
      setSaveMessage("Privat referens borttagen. Ingen bildkörning har startats.");
      await loadProfiles();
    } catch {
      setSaveState("error");
      setSaveMessage("Referensen kunde inte tas bort. Försök igen.");
    }
  }

  return (
    <section className={styles.workspace} aria-labelledby="avatar-references-title">
      <header className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>PRIVAT BILDREFERENS</p>
          <h1 id="avatar-references-title">Gör din visuella närvaro igenkännbar — utan att exponera dig.</h1>
          <p>Lägg in några egna foton som ett privat underlag. När du själv väljer det kan SAGA använda riktningen för en städad, ansiktsdold bild i ett privat utkast.</p>
        </div>
        <div className={styles.heroTrust} aria-label="Integritetsprinciper">
          <span className={styles.heroTrustIcon}><Icon name="shield" /></span>
          <div><strong>Privat från början</strong><small>Ingen originalbild blir en publik profilbild.</small></div>
        </div>
      </header>

      <section className={styles.policyStrip} aria-label="Integritet och publicering">
        <div><span><Icon name="private" /></span><p><strong>Originalen stannar privata.</strong> Vi visar inte tillbaka dem som ansiktsbilder i Studio.</p></div>
        <div><span><Icon name="eyeOff" /></span><p><strong>Ansiktet döljs som standard.</strong> Noir, silhuett, rygg, sidovinkel eller beskärning.</p></div>
        <div><span><Icon name="check" /></span><p><strong>Alltid privat först.</strong> Bilden behöver granskning innan kalender eller publicering.</p></div>
      </section>

      {loadState === "unavailable" ? (
        <section className={styles.unavailable} role="status" aria-live="polite">
          <span><Icon name="info" /></span>
          <div><h2>Privata bildreferenser är inte redo att användas än.</h2><p>{loadMessage}</p></div>
          <button type="button" onClick={() => void loadProfiles()}><Icon name="reload" />Försök igen</button>
        </section>
      ) : null}

      <div className={styles.layout}>
        <section className={styles.createCard} aria-labelledby="avatar-create-title">
          <div className={styles.cardHeader}>
            <span className={styles.cardNumber}>01</span>
            <div><p className={styles.cardEyebrow}>SKAPA PRIVAT UNDERLAG</p><h2 id="avatar-create-title">Lägg in vinklar, inte en profilbild.</h2><p>Börja med 3–6 perspektiv. När en privat referens finns kan du fylla på den upp till sex foton — utan att några ansiktstumnaglar visas.</p></div>
          </div>

          <form className={styles.form} onSubmit={saveProfile}>
            {profiles.length ? <label className={styles.field} htmlFor={`${fieldId}-target`}>
              <span>Var ska fotona sparas?</span>
              <select
                id={`${fieldId}-target`}
                value={targetProfileId ?? ""}
                onChange={(event) => {
                  setTargetProfileId(event.target.value || null);
                  setSelectedReferences([]);
                  setConsented(false);
                  setSaveMessage(null);
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }}
                disabled={loadState !== "ready" || isMutating || isFinalizationPending}
              >
                <option value="">Skapa en ny privat referens</option>
                {profiles.map((profile) => <option key={profile.id} value={profile.id} disabled={profile.references.length >= MAX_REFERENCES}>
                  {profile.label} · {referenceSummary(profile)}
                </option>)}
              </select>
              <small>Du kan fylla på en befintlig referens i stället för att skapa en ny.</small>
            </label> : null}

            {isCreatingProfile ? <label className={styles.field} htmlFor={`${fieldId}-label`}>
              <span>Namn på den privata referensen</span>
              <input
                id={`${fieldId}-label`}
                type="text"
                value={label}
                maxLength={80}
                minLength={2}
                placeholder="Exempel: Min visuella grund"
                onChange={(event) => setLabel(event.target.value)}
                disabled={loadState !== "ready" || isMutating || isFinalizationPending}
                required
              />
              <small>Det här namnet syns bara i din arbetsyta.</small>
            </label> : <div className={styles.targetSummary} role="status">
              <span><Icon name="private" /></span>
              <div><strong>Fyller på “{targetProfile.label}”</strong><small>{referenceSummary(targetProfile)} sparade · plats för {requirements.maximumFiles} {requirements.maximumFiles === 1 ? "foto" : "foton"} till.</small></div>
            </div>}

            <div className={styles.uploadField}>
              <div className={styles.uploadHeading}><span>Privata foton</span><small>{uploadCountHint(requirements, !isCreatingProfile)} · JPG, PNG eller WebP · högst 20 MB per foto</small></div>
              <input
                ref={fileInputRef}
                id={`${fieldId}-files`}
                className={styles.fileInput}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                onChange={chooseFiles}
                disabled={!canChooseFiles}
              />
              <label className={styles.uploadButton} htmlFor={`${fieldId}-files`}>
                <Icon name="add" />{uploadButtonLabel(requirements, !isCreatingProfile)}
              </label>
              <p className={styles.uploadPrivacy}><Icon name="eyeOff" />Inga ansiktsbilder förhandsvisas här.</p>
              <p className={styles.uploadDirect}><Icon name="private" />Foton över 4 MB går direkt till privat lagring, inte genom en Vercel-funktion.</p>
            </div>

            {selectedReferences.length ? <ol className={styles.selectionList} aria-label="Valda privata foton">
              {selectedReferences.map((reference, index) => <li key={reference.id}>
                <span className={styles.referenceTile} aria-hidden="true"><i /><i /><i /></span>
                <div><strong>Privat foto {String(index + 1).padStart(2, "0")}</strong><small>{Math.max(1, Math.round(reference.file.size / 1024 / 1024))} MB · visas inte som ansiktsbild</small></div>
                <label className={styles.angleField}>
                  <span className="sr-only">Vinkel för privat foto {index + 1}</span>
                  <select value={reference.angle} onChange={(event) => updateAngle(reference.id, event.target.value as AvatarReferenceAngle)} disabled={isMutating || isFinalizationPending}>
                    {angleChoices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
                  </select>
                </label>
                <button type="button" className={styles.removeButton} onClick={() => removeSelectedReference(reference.id)} aria-label={`Ta bort privat foto ${index + 1}`} disabled={isMutating || isFinalizationPending}><Icon name="trash" /></button>
              </li>)}
            </ol> : <div className={styles.emptySelection}><span><Icon name="files" /></span><p>Välj flera vinklar. SAGA sparar bara filerna när du bekräftar nedan.</p></div>}

            {selectionMessage && (selectedReferences.length > 0 || requirements.maximumFiles === 0) ? <p className={styles.validationMessage} role="status">{selectionMessage}</p> : null}

            <label className={styles.consent}>
              <input type="checkbox" checked={consented} onChange={(event) => setConsented(event.target.checked)} disabled={!canChooseFiles} />
              <span><strong>Jag bekräftar att bilderna föreställer mig, eller att jag har uttryckligt tillstånd att använda dem.</strong><small>Jag förstår att de sparas privat som bildreferens. Att använda dem med en AI-leverantör är ett separat, avstängt val.</small></span>
            </label>

            <div className={styles.formActions}>
              <button className={styles.primaryAction} type="submit" disabled={!canSave}>
                <Icon name="private" />{saveState === "saving" ? "Sparar privata foton" : isCreatingProfile ? "Spara privat referens" : "Spara privata foton"}
              </button>
              <p>Skapar ingen profilbild, visar inga original och aktiverar ingen modell automatiskt.</p>
            </div>
            {pendingFinalization ? <div className={styles.finalizationPending} role="status" aria-live="polite">
              <div><strong>Privat verifiering pågår för “{pendingFinalization.profileLabel}”.</strong><p>{saveMessage ?? "De privata fotona väntar på en sista verifiering."}</p></div>
              <button type="button" onClick={() => void retryPendingFinalization()} disabled={isMutating}>Fortsätt verifiera</button>
            </div> : saveMessage ? <p className={saveState === "error" ? styles.formMessageError : styles.formMessage} role={saveState === "error" ? "alert" : "status"}>{saveMessage}</p> : null}
          </form>
        </section>

        <aside className={styles.sideColumn}>
          <section className={styles.outputCard} aria-labelledby="avatar-output-title">
            <div className={styles.outputVisual} aria-hidden="true"><span className={styles.outputHalo} /><span className={styles.outputPerson} /><span className={styles.outputShade} /></div>
            <div><p className={styles.cardEyebrow}>STANDARDUTTRYCK</p><h2 id="avatar-output-title">Noir, aldrig ett helt ansikte.</h2><p>En privat referens kan ge kontinuitet i kroppsspråk, ljus och känsla. Den får inte bli ett ansiktsavslöjande porträtt.</p></div>
            <ul><li><Icon name="check" />Privat utkast först</li><li><Icon name="check" />Integritetskontroll före kalendern</li><li><Icon name="check" />Separat beslut per bild</li></ul>
          </section>
          <section className={styles.nextCard} aria-labelledby="avatar-next-title">
            <span><Icon name="arrow" /></span><div><p className={styles.cardEyebrow}>NÄSTA KONTROLLERADE STEG</p><h2 id="avatar-next-title">Användning väljs först i ett granskat bildflöde.</h2><p>En privat referens aktiverar inte bildskapande i sig. När det dedikerade flödet är klart väljer du den per utkast — aldrig via en automatisk publicering.</p></div>
          </section>
        </aside>
      </div>

      <section className={styles.library} aria-labelledby="avatar-library-title">
        <header><div><p className={styles.eyebrow}>SPARADE PRIVATA REFERENSER</p><h2 id="avatar-library-title">Dina underlag</h2><p>Endast metadata visas här. Inga råa bildadresser eller ansiktstumnaglar används.</p></div><span className={styles.libraryCount}>{profiles.length} {profiles.length === 1 ? "referens" : "referenser"}</span></header>
        {loadState === "loading" ? <AvatarLibrarySkeleton /> : profiles.length ? <ul className={styles.profileList}>
          {profiles.map((profile) => <li key={profile.id}>
            <span className={styles.profileTile} aria-hidden="true"><i /><i /><i /></span>
            <div className={styles.profileCopy}><strong>{profile.label}</strong><p>{referenceSummary(profile)} · {profile.references.map((reference) => angleLabel[reference.angle]).join(", ") || "Vinkel saknas"}</p><small>{profile.providerProcessing.consented ? "Samtycke dokumenterat · ingen bildkörning har startats" : "AI-behandling är avstängd tills du lämnar separat samtycke"}</small></div>
            <div className={styles.profileActions}>
              <span className={profile.providerProcessing.consented ? styles.statusActive : styles.statusIdle}>
                {profile.providerProcessing.consented
                  ? "Samtycke dokumenterat"
                  : profile.references.length < MIN_REFERENCES
                    ? `${MIN_REFERENCES - profile.references.length} vinklar återstår`
                    : "AI-behandling avstängd"}
              </span>
              {!profile.providerProcessing.consented && profile.references.length >= MIN_REFERENCES ? <button type="button" onClick={() => { setProviderConsentProfileId(profile.id); setProviderConsentAccepted(false); }} disabled={isMutating || isFinalizationPending}>Förbered privat avatarreferens</button> : null}
              <button type="button" onClick={() => void deleteProfile(profile)} disabled={isMutating || pendingFinalization?.profileId === profile.id}><Icon name="trash" />Ta bort</button>
            </div>
            {providerConsentProfileId === profile.id && !profile.providerProcessing.consented ? <div className={styles.providerConsent}>
              <label><input type="checkbox" checked={providerConsentAccepted} onChange={(event) => setProviderConsentAccepted(event.target.checked)} disabled={isMutating || isFinalizationPending} /><span><strong>Jag godkänner privat AI-behandling av denna referens.</strong><small>Den delas först med Vercel AI Gateway när du senare väljer den i ett privat utkast. Detta skapar eller publicerar ingen bild nu.</small></span></label>
              <div><button type="button" className={styles.providerConfirm} onClick={() => void enableProviderProcessing(profile)} disabled={!providerConsentAccepted || isMutating || isFinalizationPending}>Bekräfta separat samtycke</button><button type="button" className={styles.providerCancel} onClick={() => { setProviderConsentProfileId(null); setProviderConsentAccepted(false); }} disabled={isMutating || isFinalizationPending}>Avbryt</button></div>
            </div> : null}
            {profile.references.length ? <div className={styles.referenceMetadata}>
              <p><Icon name="private" />Privata vinklar · inga bilder visas här</p>
              <ul aria-label={`Privata vinklar för ${profile.label}`}>
                {profile.references.map((reference) => <li key={reference.id}>
                  <span className={styles.metadataTile} aria-hidden="true"><i /><i /><i /></span>
                  <span><strong>Referens {String(reference.position).padStart(2, "0")}</strong><small>{angleLabel[reference.angle]} · privat underlag</small></span>
                  <button type="button" onClick={() => void deleteReference(profile, reference)} disabled={isMutating || pendingFinalization?.profileId === profile.id}><Icon name="trash" />Ta bort</button>
                </li>)}
              </ul>
            </div> : null}
          </li>)}
        </ul> : <div className={styles.libraryEmpty}><span><Icon name="private" /></span><div><h3>Inga privata referenser ännu.</h3><p>Spara 3–6 egna vinklar när arbetsytan är redo. Du ser aldrig dina original som en publik bild här.</p></div></div>}
      </section>
    </section>
  );
}

function AvatarLibrarySkeleton() {
  return <div className={styles.librarySkeleton} aria-label="Läser privata referenser"><i /><i /><i /></div>;
}
