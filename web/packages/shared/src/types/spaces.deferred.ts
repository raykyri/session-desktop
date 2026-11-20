// Types of the first-draft mock backend's contract, inferred from the zod
// schemas in `../schemas/spaces.deferred.ts`. The build's contract is
// `../schemas/spaces.ts`, whose types the package root exports as `Spaces`.
// These types are not exported from the package root; the mock's validator
// test (`test/spacesMock.test.ts`) imports them from this file.

import type { z } from "zod";

import type {
  apiKeySchema,
  askTreeSchema,
  banSchema,
  citedPageSchema,
  closedSpaceStateSchema,
  createdInviteSchema,
  editConflictCurrentSchema,
  inboxNotificationPageSchema,
  inboxNotificationSchema,
  inboxNotificationTypeSchema,
  joinRequestSchema,
  moderationStateSchema,
  pageDocSchema,
  personSummarySchema,
  reportSchema,
  researchBranchRemovalSchema,
  researchExchangeNodeSchema,
  researchNodeContentSchema,
  researchNodeSchema,
  researchTreeSummarySchema,
  runFailureSchema,
  sessionEventSchema,
  skillSchema,
  sourceBlockSchema,
  sourcePolicySchema,
  sourceReportSchema,
  sourceSchema,
  spaceChangesSchema,
  spaceCollectionSchemas,
  spaceErrorCodeSchema,
  spaceErrorSchema,
  spaceMemberRoleSchema,
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
  storedResearchTreeSummarySchema,
  storedSpaceSchema,
  storedThreadInviteSchema,
  threadInviteSchema,
  threadMemberSchema,
  tokenUsageSchema,
  usageAskSchema,
  userFollowUpSchema,
  userSchema,
  userSettingsSchema,
} from "../schemas/spaces.deferred.js";

// `ResearchPostNode` (a reply) is declared with its schema in
// `../schemas/spaces.ts`: a recursive schema needs the type written out.
export type { ResearchPostNode } from "../schemas/spaces.deferred.js";

export type SpaceRole = z.infer<typeof spaceRoleSchema>;
export type SpaceMemberRole = z.infer<typeof spaceMemberRoleSchema>;
export type ClosedSpaceState = z.infer<typeof closedSpaceStateSchema>;
export type ThreadMember = z.infer<typeof threadMemberSchema>;
export type JoinRequest = z.infer<typeof joinRequestSchema>;
export type Ban = z.infer<typeof banSchema>;
export type ThreadInvite = z.infer<typeof threadInviteSchema>;
export type StoredThreadInvite = z.infer<typeof storedThreadInviteSchema>;
export type CreatedInvite = z.infer<typeof createdInviteSchema>;

export type SpaceVisibility = z.infer<typeof spaceVisibilitySchema>;
export type Space = z.infer<typeof spaceSchema>;
export type StoredSpace = z.infer<typeof storedSpaceSchema>;
export type SpaceSettings = z.infer<typeof spaceSettingsSchema>;

export type RunFailure = z.infer<typeof runFailureSchema>;
/** A thread. */
export type ResearchTreeSummary = z.infer<typeof researchTreeSummarySchema>;
/** One thread (`GET /api/threads/:id`): the same record as
 * `ResearchTreeSummary`. */
export type ResearchTreeDetail = ResearchTreeSummary;
export type StoredResearchTreeSummary = z.infer<typeof storedResearchTreeSummarySchema>;
/** An answer's HTML. */
export type ResearchNodeContent = z.infer<typeof researchNodeContentSchema>;
export type CitedPage = z.infer<typeof citedPageSchema>;
/** A follow-up on an ask thread. */
export type ResearchExchangeNode = z.infer<typeof researchExchangeNodeSchema>;
/** A node of a thread's ask tree. */
export type ResearchNode = z.infer<typeof researchNodeSchema>;
export type AskTree = z.infer<typeof askTreeSchema>;
export type ResearchBranchRemoval = z.infer<typeof researchBranchRemovalSchema>;
export type SpaceRun = z.infer<typeof spaceRunSchema>;

export type SourceBlock = z.infer<typeof sourceBlockSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type SpaceSource = z.infer<typeof spaceSourceSchema>;
export type SpaceSourceEntry = z.infer<typeof spaceSourceEntrySchema>;
export type SourcePolicy = z.infer<typeof sourcePolicySchema>;
export type SourceReport = z.infer<typeof sourceReportSchema>;

export type Report = z.infer<typeof reportSchema>;
export type ModerationState = z.infer<typeof moderationStateSchema>;

export type InboxNotificationType = z.infer<typeof inboxNotificationTypeSchema>;
export type InboxNotification = z.infer<typeof inboxNotificationSchema>;
export type InboxNotificationPage = z.infer<typeof inboxNotificationPageSchema>;

export type PageDoc = z.infer<typeof pageDocSchema>;
export type Skill = z.infer<typeof skillSchema>;

export type SpaceProfile = z.infer<typeof spaceProfileSchema>;
export type PersonSummary = z.infer<typeof personSummarySchema>;
/** The signed-in person (`GET /api/me`). */
export type User = z.infer<typeof userSchema>;
export type UserSettings = z.infer<typeof userSettingsSchema>;

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

export type SessionEvent = z.infer<typeof sessionEventSchema>;

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
