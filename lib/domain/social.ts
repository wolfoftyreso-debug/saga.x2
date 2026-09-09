import { z } from "zod";

/**
 * The public channel names deliberately match the content studio.  The
 * Instagram API integration only targets Professional (Business/Creator)
 * accounts — never consumer/personal accounts.
 */
export const SOCIAL_PROVIDER_VALUES = ["facebook_page", "instagram_professional", "linkedin"] as const;
export const socialProviderSchema = z.enum(SOCIAL_PROVIDER_VALUES);
export type SocialProvider = z.infer<typeof socialProviderSchema>;

export const SOCIAL_CHANNEL_VALUES = ["facebook_page", "instagram", "linkedin"] as const;
export const socialChannelSchema = z.enum(SOCIAL_CHANNEL_VALUES);
export type SocialChannel = z.infer<typeof socialChannelSchema>;

export const SOCIAL_CONNECTION_STATE_VALUES = ["active", "needs_reauth", "disconnected", "error"] as const;
export const socialConnectionStateSchema = z.enum(SOCIAL_CONNECTION_STATE_VALUES);
export type SocialConnectionState = z.infer<typeof socialConnectionStateSchema>;

export const SOCIAL_PUBLISH_STATE_VALUES = ["running", "published", "failed"] as const;
export const socialPublishStateSchema = z.enum(SOCIAL_PUBLISH_STATE_VALUES);
export type SocialPublishState = z.infer<typeof socialPublishStateSchema>;

export type SocialConnectionView = {
  id: string;
  provider: SocialProvider;
  providerAccountId: string;
  accountLabel: string;
  accountHandle: string | null;
  state: SocialConnectionState;
  scopes: string[];
  tokenExpiresAt: string | null;
  lastVerifiedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SocialProviderAvailability = {
  provider: SocialProvider;
  configured: boolean;
  missing: string[];
  connectUrl: string | null;
};

export type SocialMediaInput = {
  /** Must be a public HTTPS URL. Providers fetch this media themselves. */
  url: string;
  altText?: string | null;
  /** A pre-uploaded LinkedIn image URN can be supplied by a later media layer. */
  linkedInAssetUrn?: string | null;
};

export const socialMediaInputSchema = z.object({
  url: z.string().url("Bildens URL är ogiltig.").max(2_000),
  altText: z.string().trim().max(1_000).nullable().optional(),
  linkedInAssetUrn: z.string().trim().regex(/^urn:li:image:[A-Za-z0-9_-]+$/).nullable().optional(),
});

/**
 * This is the ready-to-publish seam between content drafts and provider
 * adapters. It intentionally contains no OAuth credentials or provider IDs.
 */
export const readySocialPostSchema = z.object({
  title: z.string().trim().max(180).nullable().optional(),
  headline: z.string().trim().max(220).nullable().optional(),
  body: z.string().trim().max(12_000).default(""),
  cta: z.string().trim().max(500).nullable().optional(),
  linkUrl: z.string().url("Länkens URL är ogiltig.").max(2_000).nullable().optional(),
  media: z.array(socialMediaInputSchema).max(10).default([]),
}).superRefine((value, context) => {
  if (!value.title && !value.headline && !value.body && !value.cta && value.media.length === 0 && !value.linkUrl) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Ett inlägg behöver text, länk eller media." });
  }
});
export type ReadySocialPost = z.infer<typeof readySocialPostSchema>;

export type SocialPublishResult = {
  status: "published" | "failed";
  externalPostId?: string;
  publishedAt?: string;
  errorMessage?: string;
  attemptId?: string;
};

export function providerForChannel(channel: SocialChannel): SocialProvider {
  return channel === "instagram" ? "instagram_professional" : channel;
}

export function displayNameForProvider(provider: SocialProvider): string {
  switch (provider) {
    case "facebook_page": return "Facebook-sida";
    case "instagram_professional": return "Instagram Professional";
    case "linkedin": return "LinkedIn";
  }
}

/** Concise, platform-neutral caption. Provider adapters apply their own limits. */
export function composeSocialText(post: ReadySocialPost): string {
  return [post.headline, post.body, post.cta]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}
