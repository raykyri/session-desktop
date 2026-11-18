// Types of the Spaces API, inferred from the zod schemas in
// `../schemas/spaces.ts` (the reference for the HTML mockup's mock backend,
// `docs/mockups/session-web-spaces-mock-api.js`). The real app does not serve
// this API yet; where an endpoint stands in for a real wire type, the schema's
// comment names that type and how the two differ.

import type { z } from "zod";

import type {
  accountSettingsSchema,
  apiKeySchema,
  askNodeSchema,
  askTreeSchema,
  banSchema,
  citedPageSchema,
  closedSpaceStateSchema,
  editConflictCurrentSchema,
  followUpSchema,
  inviteLinkSchema,
  joinRequestSchema,
  moderationStateSchema,
  pageDocSchema,
  personSummarySchema,
  reportSchema,
  runFailureSchema,
  skillSchema,
  sourceBlockSchema,
  sourcePolicySchema,
  sourceReportSchema,
  sourceSchema,
  spaceChangesSchema,
  spaceCollectionSchemas,
  spaceErrorCodeSchema,
  spaceErrorSchema,
  spaceEventSchema,
  spaceMeSchema,
  spaceMemberRoleSchema,
  spaceMemberSchema,
  spaceNotificationSchema,
  spaceNotificationTypeSchema,
  spaceProcedures,
  spaceProfileSchema,
  spaceQueries,
  spaceRoleSchema,
  spaceRunSchema,
  spaceSchema,
  spaceSettingsSchema,
  spaceSourceEntrySchema,
  spaceSourceSchema,
  spaceVisibilitySchema,
  storedApiKeySchema,
  storedSpaceSchema,
  storedThreadSchema,
  threadSchema,
  tokenUsageSchema,
  usageAskSchema,
  userFollowUpSchema,
} from "../schemas/spaces.js";

import type { InboxNotificationPage } from "./sharing.js";

// `Reply` is declared with its schema in `../schemas/spaces.ts`: a recursive
// schema needs the type written out.

export type SpaceRole = z.infer<typeof spaceRoleSchema>;
export type SpaceMemberRole = z.infer<typeof spaceMemberRoleSchema>;
export type ClosedSpaceState = z.infer<typeof closedSpaceStateSchema>;
export type SpaceMember = z.infer<typeof spaceMemberSchema>;
export type JoinRequest = z.infer<typeof joinRequestSchema>;
export type Ban = z.infer<typeof banSchema>;
export type InviteLink = z.infer<typeof inviteLinkSchema>;

export type SpaceVisibility = z.infer<typeof spaceVisibilitySchema>;
export type Space = z.infer<typeof spaceSchema>;
export type StoredSpace = z.infer<typeof storedSpaceSchema>;
export type SpaceSettings = z.infer<typeof spaceSettingsSchema>;

export type RunFailure = z.infer<typeof runFailureSchema>;
export type Thread = z.infer<typeof threadSchema>;
export type StoredThread = z.infer<typeof storedThreadSchema>;
export type CitedPage = z.infer<typeof citedPageSchema>;
export type FollowUp = z.infer<typeof followUpSchema>;
export type AskNode = z.infer<typeof askNodeSchema>;
export type AskTree = z.infer<typeof askTreeSchema>;
export type SpaceRun = z.infer<typeof spaceRunSchema>;

export type SourceBlock = z.infer<typeof sourceBlockSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type SpaceSource = z.infer<typeof spaceSourceSchema>;
export type SpaceSourceEntry = z.infer<typeof spaceSourceEntrySchema>;
export type SourcePolicy = z.infer<typeof sourcePolicySchema>;
export type SourceReport = z.infer<typeof sourceReportSchema>;

export type Report = z.infer<typeof reportSchema>;
export type ModerationState = z.infer<typeof moderationStateSchema>;

export type SpaceNotificationType = z.infer<typeof spaceNotificationTypeSchema>;
export type SpaceNotification = z.infer<typeof spaceNotificationSchema>;

export type PageDoc = z.infer<typeof pageDocSchema>;
/** `[name, prompt, rev?]`; the object form `{ name, prompt, rev }` is the
 * preferred wire shape for the real API (see `skillSchema`). */
export type Skill = z.infer<typeof skillSchema>;

export type SpaceProfile = z.infer<typeof spaceProfileSchema>;
export type PersonSummary = z.infer<typeof personSummarySchema>;
export type SpaceMe = z.infer<typeof spaceMeSchema>;
export type AccountSettings = z.infer<typeof accountSettingsSchema>;

/** TODO(limits) stubs. */
export type ApiKey = z.infer<typeof apiKeySchema>;
export type StoredApiKey = z.infer<typeof storedApiKeySchema>;
export type TokenUsage = z.infer<typeof tokenUsageSchema>;
export type UsageAsk = z.infer<typeof usageAskSchema>;

export type UserFollowUp = z.infer<typeof userFollowUpSchema>;

/** Every collection, as GET returns it. */
export type SpaceCollections = {
  [Name in keyof typeof spaceCollectionSchemas]: z.infer<(typeof spaceCollectionSchemas)[Name]>;
};
export type SpaceChanges = z.infer<typeof spaceChangesSchema>;

export type SpaceErrorCode = z.infer<typeof spaceErrorCodeSchema>;
export type EditConflictCurrent = z.infer<typeof editConflictCurrentSchema>;
export type SpaceError = z.infer<typeof spaceErrorSchema>;

export type SpaceEvent = z.infer<typeof spaceEventSchema>;

/** One page of a paged query: `InboxNotificationPage`'s shape with the
 * query's items. */
export type SpacePage<Item> = Omit<InboxNotificationPage, "items"> & { items: Item[] };

export type SpaceProcedureInput<Name extends keyof typeof spaceProcedures> = z.input<
  (typeof spaceProcedures)[Name]["input"]
>;
export type SpaceProcedureResult<Name extends keyof typeof spaceProcedures> = z.output<
  (typeof spaceProcedures)[Name]["result"]
>;
/** A procedure's response body. */
export interface SpaceProcedureResponse<Name extends keyof typeof spaceProcedures> {
  result: SpaceProcedureResult<Name>;
  changes: SpaceChanges;
}

export type SpaceQueryInput<Name extends keyof typeof spaceQueries> = z.input<
  (typeof spaceQueries)[Name]["input"]
>;
export type SpaceQueryOutput<Name extends keyof typeof spaceQueries> = z.output<
  (typeof spaceQueries)[Name]["output"]
>;
