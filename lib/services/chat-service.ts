import "server-only";
import { zodTextFormat } from "openai/helpers/zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  chatIntentSchema,
  looksLikeWorkspaceMutation,
  parseDeterministicChatIntent,
  type ChatIntent,
  type WeightColumn,
} from "@/lib/domain/chat-intents";
import {
  SOURCE_CATALOG,
  allowedDomainsForPolicy,
  filterSourcesByPolicy,
  normalizeSourceDomain,
  sourceAllowedByPolicy,
  type SourceCatalogEntry,
  type SourcePolicyRecord,
  type SourceRole,
} from "@/lib/domain/source-catalog";
import { getOpenAIClient, getOpenAIModel, MissingOpenAIConfigurationError } from "@/lib/openai/client";
import {
  getExplicitSourcePolicies,
  getProfileContext,
  userCanAccessEvent,
  type ConversationBlock,
  type ConversationMessageView,
  type ProfileContextView,
} from "@/lib/services/workspace";

type DatabaseClient = SupabaseClient;
type ActionReceipt = NonNullable<ConversationMessageView["action"]>;

type CommandResult = {
  text: string;
  action: ActionReceipt | null;
  persisted: boolean;
  blocks?: ConversationBlock[];
  responseMetadata?: Record<string, unknown>;
  modelName?: string | null;
};

type SourceTarget = {
  domain: string;
  sourceName: string;
  sourceKind: SourceCatalogEntry["kind"];
  defaultRoles: SourceRole[];
  current: SourcePolicyRecord | null;
};

export class ChatServiceError extends Error {
  constructor(message: string, readonly status = 500) {
    super(message);
    this.name = "ChatServiceError";
  }
}

export async function processChatTurn(input: {
  database: DatabaseClient;
  userId: string;
  message: string;
  conversationId?: string | null;
  eventId?: string | null;
}): Promise<{ conversationId: string; message: ConversationMessageView }> {
  if (input.eventId && !(await userCanAccessEvent(input.database, input.userId, input.eventId))) {
    throw new ChatServiceError("Händelsen finns inte i din brief eller dina bevakningar.", 404);
  }
  const conversationId = await resolveConversation(input.database, input.userId, input.conversationId, input.eventId);
  const { error: userMessageError } = await input.database
    .from("conversation_messages")
    .insert({
      conversation_id: conversationId,
      user_id: input.userId,
      role: "user",
      kind: "text",
      text: input.message,
      event_id: input.eventId ?? null,
    });
  if (userMessageError) throw new ChatServiceError(userMessageError.message ?? "Kunde inte spara ditt meddelande.");

  const intent = await detectChatIntent(input.message, input.eventId);
  const command = intent ? await executeIntent({ ...input, conversationId, intent }) : null;
  const result = command ?? await answerFromContext({ ...input, conversationId });
  const { data: assistantMessage, error: assistantMessageError } = await input.database
    .from("conversation_messages")
    .insert({
      conversation_id: conversationId,
      user_id: input.userId,
      role: "assistant",
      kind: result.action ? "action" : "text",
      text: result.text,
      event_id: input.eventId ?? null,
      action: result.action ?? null,
      blocks: result.blocks ?? [],
      response_metadata: result.responseMetadata ?? {},
      model_name: result.modelName ?? null,
    })
    .select("*")
    .single();
  if (assistantMessageError || !assistantMessage) throw new ChatServiceError(assistantMessageError?.message ?? "Kunde inte spara svaret.");

  if (command?.persisted && command.action) {
    const { error } = await input.database.from("command_audit").insert({
      user_id: input.userId,
      conversation_message_id: assistantMessage.id,
      command_type: command.action.type ?? "workspace_change",
      payload: command.action,
    });
    if (error) throw new ChatServiceError(`Ändringen sparades, men auditloggen kunde inte uppdateras: ${error.message}`);
  }

  return { conversationId, message: mapConversationMessage(assistantMessage) };
}

async function resolveConversation(
  database: DatabaseClient,
  userId: string,
  requestedId?: string | null,
  eventId?: string | null,
): Promise<string> {
  if (requestedId) {
    const { data, error } = await database
      .from("conversations")
      .select("id, kind, event_id")
      .eq("id", requestedId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new ChatServiceError(error.message);
    if (!data) throw new ChatServiceError("Konversationen finns inte eller tillhör en annan användare.", 404);
    if (eventId && (data.kind !== "event" || data.event_id !== eventId)) {
      throw new ChatServiceError("Konversationen hör inte till den här händelsen.", 400);
    }
    if (!eventId && data.kind !== "main") {
      throw new ChatServiceError("Den här händelsetråden måste användas från sin händelsesida.", 400);
    }
    return data.id;
  }

  if (eventId) {
    const { data: existing, error: existingError } = await database
      .from("conversations")
      .select("id")
      .eq("user_id", userId)
      .eq("kind", "event")
      .eq("event_id", eventId)
      .maybeSingle();
    if (existingError) throw new ChatServiceError(existingError.message);
    if (existing) return existing.id;

    const { data: event, error: eventError } = await database
      .from("events")
      .select("title")
      .eq("id", eventId)
      .maybeSingle();
    if (eventError || !event) throw new ChatServiceError("Händelsen går inte längre att öppna som en tråd.", 404);

    const { data: created, error: createError } = await database
      .from("conversations")
      .insert({ user_id: userId, kind: "event", event_id: eventId, title: `Händelse: ${String(event.title).slice(0, 180)}` })
      .select("id")
      .single();
    if (createError || !created) {
      // The (user_id, event_id) partial unique index makes this race-safe.
      const { data: raced } = await database
        .from("conversations")
        .select("id")
        .eq("user_id", userId)
        .eq("kind", "event")
        .eq("event_id", eventId)
        .maybeSingle();
      if (raced) return raced.id;
      throw new ChatServiceError(createError?.message ?? "Kunde inte skapa händelsetråden.");
    }
    return created.id;
  }

  const { data: existing, error: existingError } = await database
    .from("conversations")
    .select("id")
    .eq("user_id", userId)
    .eq("kind", "main")
    .maybeSingle();
  if (existingError) throw new ChatServiceError(existingError.message);
  if (existing) return existing.id;

  const { data: created, error: createError } = await database
    .from("conversations")
    .insert({ user_id: userId, kind: "main", title: "Din omvärldsbrief" })
    .select("id")
    .single();
  if (createError || !created) {
    const { data: raced } = await database
      .from("conversations")
      .select("id")
      .eq("user_id", userId)
      .eq("kind", "main")
      .maybeSingle();
    if (raced) return raced.id;
    throw new ChatServiceError(createError?.message ?? "Kunde inte skapa konversationen.");
  }
  return created.id;
}

/**
 * Explicit commands use a local parser. Natural-language configuration requests
 * that the local parser cannot safely resolve are classified with Structured
 * Outputs; the returned object is parsed again by Zod and only then reaches the
 * ownership-scoped mutation layer below.
 */
async function detectChatIntent(message: string, eventId?: string | null): Promise<ChatIntent | null> {
  const deterministic = parseDeterministicChatIntent(message, eventId);
  if (deterministic) return deterministic;
  if (!looksLikeWorkspaceMutation(message)) return null;

  try {
    const response = await getOpenAIClient().responses.parse({
      model: getOpenAIModel(),
      store: false,
      max_output_tokens: 700,
      instructions: `Du klassificerar ett svenskt användarmeddelande för en personlig briefapp. Returnera ENDAST ett objekt som följer schemat. Du får aldrig påstå att en ändring är gjord och får aldrig välja eller hitta på databas-id:n. Välj "none" för vanliga frågor. Välj "clarify" när användarens önskade ändring saknar ett säkert ämne, en källa eller en brief. För en ändring måste användarens avsikt vara tydlig. sourceRoles får endast innehålla relevanta, uttalade roller.`,
      input: message,
      text: { format: zodTextFormat(chatIntentSchema, "workspace_intent") },
    });
    if (response.status !== "completed" || !response.output_parsed) {
      return clarificationIntent("Jag kunde inte avgöra vilken inställning du vill ändra. Inget har ändrats; skriv gärna mer konkret.");
    }
    const parsed = chatIntentSchema.parse(response.output_parsed);
    return parsed.kind === "none" ? null : parsed;
  } catch (error) {
    if (error instanceof MissingOpenAIConfigurationError) {
      return clarificationIntent("Jag kan inte tolka den här inställningsändringen säkert utan en språkmodell. Inget har ändrats; skriv gärna till exempel “Pausa briefen EU-regler” eller “Blockera CNN”.");
    }
    return clarificationIntent("Jag kunde inte tolka inställningsändringen säkert just nu. Inget har ändrats.");
  }
}

function clarificationIntent(message: string): ChatIntent {
  return chatIntentSchema.parse({
    kind: "clarify",
    operation: "none",
    sourceQuery: null,
    sourceUrl: null,
    sourceName: null,
    sourceRoles: [],
    sourcePriority: null,
    sourceTopicFilter: null,
    sourceVerificationRequirement: null,
    sourceFrequency: null,
    watchTitle: null,
    triggerStatuses: [],
    briefName: null,
    briefKind: null,
    briefCadence: null,
    briefLocalTime: null,
    briefWeekday: null,
    briefInstructions: null,
    weightColumn: null,
    weightDelta: null,
    clarification: message,
  });
}

async function executeIntent(input: {
  database: DatabaseClient;
  userId: string;
  message: string;
  eventId?: string | null;
  conversationId: string;
  intent: ChatIntent;
}): Promise<CommandResult | null> {
  const { intent } = input;
  if (intent.kind === "none") return null;
  if (intent.kind === "clarify") {
    return {
      text: intent.clarification ?? "Jag behöver ett förtydligande innan jag ändrar något. Inget har ändrats.",
      action: { type: "clarification", title: "Behöver förtydligande", detail: "Inget har ändrats." },
      persisted: false,
    };
  }

  if (intent.kind === "source_add") return intent.operation === "create" ? addSource(input, intent) : clarificationResult("Jag behöver en tydlig begäran om att lägga till en källa. Inget har ändrats.");
  if (intent.kind === "source_update") {
    if (!["block", "restore", "update"].includes(intent.operation)) return clarificationResult("Jag kan inte säkert avgöra källändringen. Inget har ändrats.");
    if (intent.operation === "update" && !intent.sourceRoles.length && !intent.sourcePriority && !intent.sourceTopicFilter && !intent.sourceVerificationRequirement && !intent.sourceFrequency) {
      return clarificationResult("Jag behöver veta vilka källregler som ska ändras. Inget har ändrats.");
    }
    return updateSource(input, intent);
  }
  if (intent.kind === "event_watch_create") return intent.operation === "create" ? createEventWatch(input, intent) : clarificationResult("Jag behöver en tydlig begäran om att skapa bevakningen. Inget har ändrats.");
  if (intent.kind === "topic_watch_create") return intent.operation === "create" ? createTopicWatch(input, intent) : clarificationResult("Jag behöver en tydlig begäran om att skapa bevakningen. Inget har ändrats.");
  if (intent.kind === "brief_create") return intent.operation === "create" ? createBrief(input, intent) : clarificationResult("Jag behöver en tydlig begäran om att skapa briefen. Inget har ändrats.");
  if (intent.kind === "brief_state") return ["pause", "resume"].includes(intent.operation) ? setBriefState(input, intent) : clarificationResult("Jag kan inte säkert avgöra om briefen ska pausas eller återupptas. Inget har ändrats.");
  if (intent.kind === "brief_delete") return intent.operation === "delete" ? deleteBrief(input, intent) : clarificationResult("Jag behöver en tydlig begäran om att ta bort briefen. Inget har ändrats.");
  if (intent.kind === "weight_adjust") return ["increase", "decrease"].includes(intent.operation) ? updateWeight(input, intent) : clarificationResult("Jag kan inte säkert avgöra vilken prioritet som ska ändras. Inget har ändrats.");
  return null;
}

async function addSource(input: Parameters<typeof executeIntent>[0], intent: ChatIntent): Promise<CommandResult> {
  const domain = intent.sourceUrl ? normalizeSourceDomain(intent.sourceUrl) : null;
  if (!domain) return clarificationResult("Jag behöver en giltig URL för att lägga till en källa. Inget har ändrats.");
  const sourceName = intent.sourceName && !/^https?:\/\//i.test(intent.sourceName) ? intent.sourceName : domain;
  const { error } = await input.database.from("user_source_policies").upsert({
    user_id: input.userId,
    domain,
    source_name: sourceName,
    source_kind: "custom",
    active: true,
    blocked: false,
    priority: intent.sourcePriority ?? "normal",
    roles: intent.sourceRoles.length ? intent.sourceRoles : ["discovery", "analysis"],
    topic_filter: intent.sourceTopicFilter ?? "",
    verification_requirement: intent.sourceVerificationRequirement ?? "verify_material",
    frequency: intent.sourceFrequency ?? "material",
  }, { onConflict: "user_id,domain" });
  if (error) throw new ChatServiceError(`Kunde inte lägga till källan: ${error.message}`);
  return {
    text: `Klart. ${sourceName} är nu en egen källa med de valda rollerna. Materiella faktapåståenden kräver fortfarande din verifieringspolicy.`,
    action: { type: "source_added", title: "Egen källa tillagd", detail: domain, href: "/settings/sources" },
    persisted: true,
  };
}

async function updateSource(input: Parameters<typeof executeIntent>[0], intent: ChatIntent): Promise<CommandResult> {
  const target = await resolveSourceTarget(input.database, input.userId, intent.sourceQuery ?? intent.sourceName);
  if (!target) return clarificationResult("Jag hittar inte den källan i din källpolicy. Lägg till en tydlig URL först, eller skriv källans namn eller domän.");
  const restoring = intent.operation === "restore";
  const blocking = intent.operation === "block";
  const roles = blocking ? [] : intent.sourceRoles.length ? intent.sourceRoles : restoring ? target.defaultRoles : target.current?.roles ?? target.defaultRoles;
  const active = !blocking;
  const { error } = await input.database.from("user_source_policies").upsert({
    user_id: input.userId,
    domain: target.domain,
    source_name: target.sourceName,
    source_kind: target.sourceKind,
    active,
    blocked: blocking,
    priority: intent.sourcePriority ?? target.current?.priority ?? "normal",
    roles,
    topic_filter: intent.sourceTopicFilter ?? target.current?.topicFilter ?? "",
    verification_requirement: intent.sourceVerificationRequirement ?? target.current?.verificationRequirement ?? "verify_material",
    frequency: intent.sourceFrequency ?? target.current?.frequency ?? "material",
  }, { onConflict: "user_id,domain" });
  if (error) throw new ChatServiceError(`Kunde inte spara källregeln: ${error.message}`);

  const statement = blocking
    ? `${target.sourceName} används inte längre för upptäckt, verifiering, analys eller citering.`
    : restoring
      ? `${target.sourceName} kan nu användas igen enligt sina valda roller.`
      : `${target.sourceName}s källroller är uppdaterade.`;
  return {
    text: `Klart. ${statement}`,
    action: { type: "source_policy", title: "Källregel uppdaterad", detail: statement, href: "/settings/sources" },
    persisted: true,
  };
}

async function createEventWatch(input: Parameters<typeof executeIntent>[0], intent: ChatIntent): Promise<CommandResult> {
  if (!input.eventId) return clarificationResult("Öppna den händelse du vill följa och be mig bevaka den därifrån. Inget har ändrats.");
  const { data: event, error: eventError } = await input.database
    .from("events")
    .select("title")
    .eq("id", input.eventId)
    .maybeSingle();
  if (eventError || !event) throw new ChatServiceError("Händelsen går inte längre att bevaka.", 404);
  const { data: existing, error: existingError } = await input.database
    .from("watches")
    .select("id")
    .eq("user_id", input.userId)
    .eq("event_id", input.eventId)
    .eq("state", "active")
    .maybeSingle();
  if (existingError) throw new ChatServiceError(`Kunde inte kontrollera bevakningen: ${existingError.message}`);
  if (existing) {
    return {
      text: `${event.title} bevakas redan aktivt. Jag hör av mig först när den når en vald status eller faktiskt förändras.`,
      action: { type: "watch_exists", title: "Bevakning finns redan", detail: event.title, href: "/watches" },
      persisted: false,
    };
  }
  const triggerStatuses = intent.triggerStatuses.length ? intent.triggerStatuses : ["changed", "reversed"];
  const { error: watchError } = await input.database.from("watches").insert({
    user_id: input.userId,
    event_id: input.eventId,
    kind: "event",
    title: event.title,
    rationale: input.message,
    trigger_statuses: triggerStatuses,
    only_material_change: true,
  });
  if (watchError) throw new ChatServiceError(watchError.message ?? "Kunde inte skapa bevakningen.");
  const condition = triggerStatuses.map(statusLabel).join(", ");
  return {
    text: `Klart. Jag bevakar ${event.title} och hör av mig vid: ${condition}.`,
    action: { type: "watch_created", title: "Bevakning skapad", detail: `${event.title} · ${condition}`, href: "/watches" },
    persisted: true,
  };
}

async function createTopicWatch(input: Parameters<typeof executeIntent>[0], intent: ChatIntent): Promise<CommandResult> {
  const title = intent.watchTitle?.trim();
  if (!title || title.length < 2) return clarificationResult("Jag behöver ett tydligt ämne för bevakningen. Inget har ändrats.");
  const { data: existing, error: existingError } = await input.database
    .from("watches")
    .select("id, title")
    .eq("user_id", input.userId)
    .eq("kind", "topic")
    .eq("state", "active");
  if (existingError) throw new ChatServiceError(`Kunde inte kontrollera bevakningen: ${existingError.message}`);
  const duplicate = (existing ?? []).some((watch: { title?: string }) => watch.title?.localeCompare(title, "sv-SE", { sensitivity: "base" }) === 0);
  if (duplicate) {
    return {
      text: `“${title}” bevakas redan aktivt. Jag skickar inget förrän en matchad händelse faktiskt ändrar status eller innebörd.`,
      action: { type: "watch_exists", title: "Bevakning finns redan", detail: title, href: "/watches" },
      persisted: false,
    };
  }
  const triggerStatuses = intent.triggerStatuses.length ? intent.triggerStatuses : ["changed", "reversed"];
  const { error } = await input.database.from("watches").insert({
    user_id: input.userId,
    kind: "topic",
    title,
    query_text: title,
    rationale: input.message,
    trigger_statuses: triggerStatuses,
    only_material_change: true,
  });
  if (error) throw new ChatServiceError(`Kunde inte skapa bevakningen: ${error.message}`);
  return {
    text: `Klart. “${title}” är nu en aktiv ämnesbevakning. Jag håller den tyst tills något materiellt ändras.`,
    action: { type: "topic_watch_created", title: "Ämnesbevakning skapad", detail: title, href: "/watches" },
    persisted: true,
  };
}

async function createBrief(input: Parameters<typeof executeIntent>[0], intent: ChatIntent): Promise<CommandResult> {
  const name = intent.briefName?.trim();
  if (!name || name.length < 2) return clarificationResult("Jag behöver ett namn eller ämne för briefen. Inget har ändrats.");
  const { data: profile, error: profileError } = await input.database
    .from("profiles")
    .select("timezone, max_items, brief_depth, relevance_threshold, alert_threshold")
    .eq("user_id", input.userId)
    .single();
  if (profileError || !profile) throw new ChatServiceError("Kunde inte läsa din profil innan briefen skapades.");
  const cadence = intent.briefCadence ?? "daily";
  const { data, error } = await input.database.from("brief_definitions").insert({
    user_id: input.userId,
    name: name.slice(0, 80),
    kind: intent.briefKind && intent.briefKind !== "main" ? intent.briefKind : "custom",
    instructions: intent.briefInstructions ?? `Fokusera på ${name}.`,
    cadence,
    local_time: intent.briefLocalTime ?? "07:00",
    weekday: cadence === "weekly" ? intent.briefWeekday ?? 0 : null,
    timezone: profile.timezone ?? "Europe/Stockholm",
    max_items: profile.max_items ?? 5,
    brief_depth: profile.brief_depth ?? "short",
    relevance_threshold: profile.relevance_threshold ?? 65,
    alert_threshold: profile.alert_threshold ?? 85,
    only_when_changed: true,
    active: true,
  }).select("id, name").single();
  if (error || !data) throw new ChatServiceError(error?.message ?? "Kunde inte skapa briefen.");
  const cadenceLabel = cadence === "weekly" ? "veckovis" : "daglig";
  return {
    text: `Klart. Briefen “${data.name}” är sparad som ${cadenceLabel} och levereras bara när något materiellt har förändrats.`,
    action: { type: "brief_created", title: "Brief sparad", detail: data.name, href: "/briefs" },
    persisted: true,
  };
}

async function setBriefState(input: Parameters<typeof executeIntent>[0], intent: ChatIntent): Promise<CommandResult> {
  const definition = await resolveBriefDefinition(input.database, input.userId, intent.briefName);
  if (!definition) return clarificationResult("Jag hittar inte en unik brief med det namnet. Ange briefens namn eller öppna Briefar för att ändra den där. Inget har ändrats.");
  const active = intent.operation === "resume";
  if (definition.is_primary && !active) {
    return clarificationResult("Huvudbriefen måste vara aktiv. Skapa eller pausa en separat brief i stället; inget har ändrats.");
  }
  if (definition.active === active) {
    return {
      text: `Briefen “${definition.name}” är redan ${active ? "aktiv" : "pausad"}.`,
      action: { type: "brief_state", title: "Ingen ändring behövdes", detail: definition.name, href: "/briefs" },
      persisted: false,
    };
  }
  const { error } = await input.database
    .from("brief_definitions")
    .update({ active })
    .eq("id", definition.id)
    .eq("user_id", input.userId);
  if (error) throw new ChatServiceError(`Kunde inte uppdatera briefen: ${error.message}`);
  return {
    text: `Klart. Briefen “${definition.name}” är nu ${active ? "aktiv" : "pausad"}.`,
    action: { type: "brief_state", title: active ? "Brief återupptagen" : "Brief pausad", detail: definition.name, href: "/briefs" },
    persisted: true,
  };
}

async function deleteBrief(input: Parameters<typeof executeIntent>[0], intent: ChatIntent): Promise<CommandResult> {
  const definition = await resolveBriefDefinition(input.database, input.userId, intent.briefName);
  if (!definition) return clarificationResult("Jag hittar inte en unik brief med det namnet. Inget har tagits bort.");
  if (definition.is_primary) {
    return clarificationResult("Huvudbriefen kan inte tas bort här. Pausa eller redigera den i stället; inget har tagits bort.");
  }
  const { error } = await input.database
    .from("brief_definitions")
    .delete()
    .eq("id", definition.id)
    .eq("user_id", input.userId);
  if (error) throw new ChatServiceError(`Kunde inte ta bort briefen: ${error.message}`);
  return {
    text: `Klart. Briefen “${definition.name}” är borttagen.`,
    action: { type: "brief_deleted", title: "Brief borttagen", detail: definition.name, href: "/briefs" },
    persisted: true,
  };
}

async function updateWeight(input: Parameters<typeof executeIntent>[0], intent: ChatIntent): Promise<CommandResult> {
  if (!intent.weightColumn || !intent.weightDelta) return clarificationResult("Jag behöver veta vilket område som ska prioriteras mer eller mindre. Inget har ändrats.");
  const column = intent.weightColumn as WeightColumn;
  const { data: profile, error: profileError } = await input.database
    .from("profiles")
    .select(column)
    .eq("user_id", input.userId)
    .single();
  if (profileError || !profile) throw new ChatServiceError("Kunde inte läsa din profil.");
  const previous = Number((profile as Record<string, unknown>)[column]);
  const next = Math.max(0, Math.min(100, previous + intent.weightDelta));
  const { error } = await input.database
    .from("profiles")
    .update({ [column]: next })
    .eq("user_id", input.userId);
  if (error) throw new ChatServiceError(`Kunde inte uppdatera din prioritet: ${error.message}`);
  const label = weightLabel(column);
  return {
    text: `Klart. Prioriteten för ${label} är nu ${next}/100 och används i framtida urval.`,
    action: { type: "profile_updated", title: "Prioritet uppdaterad", detail: `${label}: ${next}/100`, href: "/settings" },
    persisted: true,
  };
}

async function resolveSourceTarget(database: DatabaseClient, userId: string, query: string | null): Promise<SourceTarget | null> {
  const normalizedQuery = query?.trim().toLocaleLowerCase("sv-SE");
  if (!normalizedQuery) return null;
  const { data, error } = await database
    .from("user_source_policies")
    .select("*")
    .eq("user_id", userId);
  if (error) throw new ChatServiceError(`Kunde inte läsa dina källregler: ${error.message}`);
  const policies = (data ?? []) as Array<Record<string, unknown>>;
  const normalizedDomain = normalizeSourceDomain(normalizedQuery);
  const raw = policies.find((policy) => String(policy.domain).toLocaleLowerCase("sv-SE") === normalizedDomain)
    ?? policies.find((policy) => String(policy.source_name).toLocaleLowerCase("sv-SE").includes(normalizedQuery));
  const catalog = SOURCE_CATALOG.find((entry) => entry.domain === normalizedDomain || entry.name.toLocaleLowerCase("sv-SE").includes(normalizedQuery));
  if (raw) {
    return {
      domain: String(raw.domain),
      sourceName: String(raw.source_name),
      sourceKind: raw.source_kind as SourceCatalogEntry["kind"],
      defaultRoles: catalog?.defaultRoles ?? ["discovery", "analysis"],
      current: mapPolicy(raw),
    };
  }
  if (!catalog) return null;
  return { domain: catalog.domain, sourceName: catalog.name, sourceKind: catalog.kind, defaultRoles: catalog.defaultRoles, current: null };
}

function mapPolicy(raw: Record<string, unknown>): SourcePolicyRecord {
  const roles = Array.isArray(raw.roles) ? raw.roles.filter((role): role is SourceRole => typeof role === "string" && ["discovery", "analysis", "verification", "citation", "direct_monitoring"].includes(role)) : [];
  return {
    domain: String(raw.domain),
    sourceName: String(raw.source_name),
    sourceKind: raw.source_kind as SourcePolicyRecord["sourceKind"],
    active: Boolean(raw.active),
    blocked: Boolean(raw.blocked),
    priority: raw.priority as SourcePolicyRecord["priority"],
    roles,
    topicFilter: String(raw.topic_filter ?? ""),
    verificationRequirement: raw.verification_requirement as SourcePolicyRecord["verificationRequirement"],
    frequency: raw.frequency as SourcePolicyRecord["frequency"],
  };
}

async function resolveBriefDefinition(database: DatabaseClient, userId: string, name: string | null): Promise<{ id: string; name: string; active: boolean; is_primary: boolean } | null> {
  const { data, error } = await database
    .from("brief_definitions")
    .select("id, name, active, is_primary")
    .eq("user_id", userId);
  if (error) throw new ChatServiceError(`Kunde inte läsa briefarna: ${error.message}`);
  const definitions = (data ?? []) as Array<{ id: string; name: string; active: boolean; is_primary: boolean }>;
  if (!name) return definitions.find((definition) => definition.is_primary) ?? null;
  const normalized = name.toLocaleLowerCase("sv-SE").trim();
  const exact = definitions.filter((definition) => definition.name.toLocaleLowerCase("sv-SE") === normalized);
  if (exact.length === 1) return exact[0];
  const partial = definitions.filter((definition) => definition.name.toLocaleLowerCase("sv-SE").includes(normalized));
  return partial.length === 1 ? partial[0] : null;
}

async function answerFromContext(input: {
  database: DatabaseClient;
  userId: string;
  message: string;
  conversationId: string;
  eventId?: string | null;
}): Promise<CommandResult> {
  const [profileContext, messagesResult, eventResult, sourcePolicies] = await Promise.all([
    getProfileContext(input.database, input.userId),
    input.database.from("conversation_messages").select("role, text, created_at").eq("conversation_id", input.conversationId).order("created_at", { ascending: false }).limit(12),
    input.eventId
      ? loadEventConversationContext(input.database, input.eventId)
      : Promise.resolve({ data: null, error: null }),
    getExplicitSourcePolicies(input.database, input.userId),
  ]);
  if (messagesResult.error) throw new ChatServiceError(`Kunde inte läsa konversationen: ${messagesResult.error.message}`);
  if (eventResult.error) throw new ChatServiceError(`Kunde inte läsa händelsen: ${eventResult.error.message}`);
  const transcript = (messagesResult.data ?? []).reverse().map((message: Record<string, unknown>) => `${message.role}: ${String(message.text)}`).join("\n");
  const eventSummary = eventResult.data ? JSON.stringify(eventContextForPrompt(eventResult.data as EventConversationContext, sourcePolicies)) : "Ingen specifik händelse är kopplad till frågan.";
  const allowedDomains = allowedChatDomains(sourcePolicies);

  try {
    const response = await getOpenAIClient().responses.create({
      model: getOpenAIModel(),
      store: false,
      max_output_tokens: 1_000,
      instructions: `Du är en svensk personlig omvärldsassistent. Svara som en rak operativ briefing, inte som en politiker, krönikör eller konsult. Skriv korta, konkreta meningar och börja med vad som är bekräftat. Säg sedan exakt vad det betyder för användaren och vad användaren ska göra — eller skriv tydligt "Gör inget nu" när ingen åtgärd krävs. Använd ordet "kan" bara när osäkerheten är verklig; skriv då villkoret direkt, till exempel "Det berör er bara om ...". Undvik retoriska öppningar, utfyllnad och fraser som "det här handlar om" eller "spelar roll".\n\nAnvänd användarens profil som relevanskontext även för personliga intressen, men hitta inte på fakta om användaren. Om du använder aktuella fakta från webben, grunda dem bara i den tillåtna källsökningen och skriv inte påhittade källor eller statusar. Källor som faktiskt användes visas separat i gränssnittet. Om underlag saknas ska du säga det rakt ut. Du ger aldrig köp- eller säljråd. Skilj tydligt mellan bekräftat, föreslaget och osäkert när det behövs.\n\nAnvändarprofil:\n${profilePrompt(profileContext)}\n\nAktuell händelse:\n${eventSummary}\n\nSenaste konversation:\n${transcript}`,
      input: input.message,
      ...(allowedDomains.length ? {
        tool_choice: "required" as const,
        tools: [{
          type: "web_search" as const,
          search_context_size: "medium" as const,
          filters: { allowed_domains: allowedDomains },
          user_location: { type: "approximate" as const, country: "SE", timezone: "Europe/Stockholm" },
        }],
      } : {}),
    });
    if (response.status !== "completed" || !response.output_text) throw new Error("Modellsvar saknas.");
    const citations = extractCitations(response.output, sourcePolicies);
    const webSearchCalls = response.output.filter((item) => item.type === "web_search_call").length;
    return {
      text: response.output_text.trim(),
      action: null,
      blocks: citations.length ? [{ type: "citations", sources: citations }] : [],
      responseMetadata: {
        responseId: response.id,
        webSearchCalls,
        citationCount: citations.length,
      },
      modelName: response.model,
      persisted: false,
    };
  } catch (error) {
    if (error instanceof MissingOpenAIConfigurationError) {
      throw new ChatServiceError("OPENAI_API_KEY saknas. Lägg in den innan fria chattfrågor kan besvaras.", 503);
    }
    throw new ChatServiceError(error instanceof Error ? `Chatten kunde inte svara: ${error.message}` : "Chatten kunde inte svara just nu.", 502);
  }
}

type EventConversationContext = {
  event: Record<string, unknown>;
  updates: Array<Record<string, unknown>>;
  sources: Array<{
    event_update_id: string | null;
    source_name: string;
    url: string;
    source_type: "primary" | "secondary";
    published_at: string | null;
    event_date: string | null;
    supports_claim: string;
  }>;
};

async function loadEventConversationContext(
  database: DatabaseClient,
  eventId: string,
): Promise<{ data: EventConversationContext | null; error: { message?: string } | null }> {
  const [eventResult, updatesResult, sourcesResult] = await Promise.all([
    database.from("events").select("title, status, event_date, effective_date, latest_terms_summary, confidence").eq("id", eventId).maybeSingle(),
    database
      .from("event_updates")
      .select("id, previous_status, new_status, kind, change_summary, terms_summary, event_date, effective_date, confidence, occurred_at")
      .eq("event_id", eventId)
      .order("occurred_at", { ascending: false })
      .limit(8),
    database
      .from("event_sources")
      .select("event_update_id, source_name, url, source_type, published_at, event_date, supports_claim")
      .eq("event_id", eventId)
      .order("published_at", { ascending: false })
      .limit(30),
  ]);
  const error = eventResult.error ?? updatesResult.error ?? sourcesResult.error;
  if (error) return { data: null, error };
  if (!eventResult.data) return { data: null, error: null };
  return {
    data: {
      event: eventResult.data as Record<string, unknown>,
      updates: (updatesResult.data ?? []) as Array<Record<string, unknown>>,
      sources: (sourcesResult.data ?? []) as EventConversationContext["sources"],
    },
    error: null,
  };
}

function eventContextForPrompt(context: EventConversationContext, sourcePolicies: SourcePolicyRecord[]): Record<string, unknown> {
  const visibleSources = filterSourcesByPolicy(
    context.sources.map((source) => ({
      sourceName: source.source_name,
      url: source.url,
      sourceType: source.source_type,
      publishedAt: source.published_at,
      eventDate: source.event_date,
      supportsClaim: source.supports_claim,
    })),
    sourcePolicies,
    "citation",
  );
  return {
    current: context.event,
    // Oldest first is easier for the model when comparing before/after state.
    timeline: [...context.updates].reverse(),
    sources: visibleSources,
  };
}

function allowedChatDomains(policies: SourcePolicyRecord[]): string[] {
  const policyDomains = allowedDomainsForPolicy(policies).filter((domain) => sourceAllowedByPolicy(`https://${domain}`, policies, "citation"));
  const configuredDomains = process.env.BRIEF_ALLOWED_DOMAINS
    ?.split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
  return (configuredDomains?.length ? policyDomains.filter((domain) => configuredDomains.includes(domain)) : policyDomains).slice(0, 100);
}

function profilePrompt(context: ProfileContextView | null): string {
  if (!context) return "Profilen är ännu inte ifylld.";
  return JSON.stringify({
    summary: context.workSummary,
    role: context.roleTitle,
    organizations: context.organizations,
    sectors: context.sectors,
    markets: context.markets,
    dependencies: context.dependencies,
    decisions: context.decisions,
    risks: context.risks,
    opportunities: context.opportunities,
    interests: context.interests,
    exclusions: context.exclusions,
    languages: context.languages,
  });
}

function extractCitations(output: unknown[], policies: SourcePolicyRecord[]): Array<{ title: string; url: string }> {
  const seen = new Set<string>();
  const citations: Array<{ title: string; url: string }> = [];
  for (const item of output) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (!isRecord(content) || content.type !== "output_text" || !Array.isArray(content.annotations)) continue;
      for (const annotation of content.annotations) {
        if (!isRecord(annotation) || annotation.type !== "url_citation" || typeof annotation.url !== "string") continue;
        if (!sourceAllowedByPolicy(annotation.url, policies, "citation") || seen.has(annotation.url)) continue;
        seen.add(annotation.url);
        citations.push({ title: typeof annotation.title === "string" && annotation.title.trim() ? annotation.title.trim().slice(0, 200) : annotation.url, url: annotation.url });
      }
    }
  }
  return citations.slice(0, 8);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clarificationResult(text: string): CommandResult {
  return { text, action: { type: "clarification", title: "Behöver förtydligande", detail: "Inget har ändrats." }, persisted: false };
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    signed: "undertecknat",
    adopted: "antaget",
    effective: "i kraft",
    implemented: "implementerat",
    changed: "väsentligt ändrat",
    reversed: "upphävt eller återkallat",
  };
  return labels[status] ?? status;
}

function weightLabel(column: WeightColumn): string {
  const labels: Record<WeightColumn, string> = {
    economy_weight: "ekonomi och marknader",
    technology_weight: "teknik",
    regulation_weight: "reglering",
    geopolitics_weight: "geopolitik och handel",
    sweden_eu_weight: "Sverige/EU",
    usa_weight: "USA",
    gulf_weight: "Gulfregionen",
  };
  return labels[column];
}

function mapConversationMessage(raw: Record<string, unknown>): ConversationMessageView {
  return {
    id: String(raw.id),
    role: raw.role as ConversationMessageView["role"],
    kind: raw.kind as ConversationMessageView["kind"],
    text: String(raw.text ?? ""),
    action: raw.action && typeof raw.action === "object" && !Array.isArray(raw.action) ? raw.action as ConversationMessageView["action"] : null,
    blocks: Array.isArray(raw.blocks) ? raw.blocks.filter(isRecord) as ConversationBlock[] : [],
    responseMetadata: raw.response_metadata && typeof raw.response_metadata === "object" && !Array.isArray(raw.response_metadata) ? raw.response_metadata as Record<string, unknown> : {},
    briefId: typeof raw.brief_id === "string" ? raw.brief_id : null,
    brief: null,
    eventId: typeof raw.event_id === "string" ? raw.event_id : null,
    watchId: typeof raw.watch_id === "string" ? raw.watch_id : null,
    createdAt: String(raw.created_at),
  };
}
