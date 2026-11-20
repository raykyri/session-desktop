// Types of the spaces contract, inferred from the zod schemas in
// `../schemas/spaces.ts`. The package root exports them as the type namespace
// `Spaces` (`import type { Spaces } from "@session/shared"`, then
// `Spaces.ThreadRecord`), and their schemas as `spaces`.

import type { z } from "zod";

import type {
  accountInviteSchema,
  answerRecordSchema,
  askNodeKindSchema,
  askNodeRefSchema,
  banRecordSchema,
  citedPageSchema,
  commentRecordSchema,
  countsRecordSchema,
  inviteRecordSchema,
  memberRecordSchema,
  moderationStateSchema,
  modlogRecordSchema,
  mutatorWhoSchema,
  nodeRecordSchema,
  notificationRecordSchema,
  notificationTypeSchema,
  prefsRecordSchema,
  replyRecordSchema,
  runBillSchema,
  runFailureSchema,
  runRecordSchema,
  runStatusSchema,
  saveRecordSchema,
  spaceEffortSchema,
  spaceErrorCodeSchema,
  spaceErrorSchema,
  spaceMemberRoleSchema,
  spaceMutators,
  spaceOnlineProcedures,
  spaceRecordSchema,
  spaceRefusalReasonSchema,
  spaceRoleSchema,
  spaceRunDeltaSchema,
  spaceVisibilitySchema,
  statsRecordSchema,
  storedRecordSchema,
  threadRecordSchema,
  turnRecordSchema,
  userProviderSchema,
  userStatusSchema,
} from "../schemas/spaces.js";

export type { InviteTreeNode } from "../schemas/spaces.js";

export type SpaceMemberRole = z.infer<typeof spaceMemberRoleSchema>;
export type SpaceRole = z.infer<typeof spaceRoleSchema>;
export type SpaceVisibility = z.infer<typeof spaceVisibilitySchema>;
export type ModerationState = z.infer<typeof moderationStateSchema>;
export type AskNodeRef = z.infer<typeof askNodeRefSchema>;
export type AskNodeKind = z.infer<typeof askNodeKindSchema>;
export type Effort = z.infer<typeof spaceEffortSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type RunFailure = z.infer<typeof runFailureSchema>;
export type RunBill = z.infer<typeof runBillSchema>;
export type CitedPage = z.infer<typeof citedPageSchema>;
export type NotificationType = z.infer<typeof notificationTypeSchema>;
export type MutatorWho = z.infer<typeof mutatorWhoSchema>;

export type SpaceRecord = z.infer<typeof spaceRecordSchema>;
export type StatsRecord = z.infer<typeof statsRecordSchema>;
export type MemberRecord = z.infer<typeof memberRecordSchema>;
export type ThreadRecord = z.infer<typeof threadRecordSchema>;
export type CountsRecord = z.infer<typeof countsRecordSchema>;
export type NodeRecord = z.infer<typeof nodeRecordSchema>;
export type RunRecord = z.infer<typeof runRecordSchema>;
export type TurnRecord = z.infer<typeof turnRecordSchema>;
export type AnswerRecord = z.infer<typeof answerRecordSchema>;
export type ReplyRecord = z.infer<typeof replyRecordSchema>;
export type CommentRecord = z.infer<typeof commentRecordSchema>;
export type BanRecord = z.infer<typeof banRecordSchema>;
export type InviteRecord = z.infer<typeof inviteRecordSchema>;
export type SaveRecord = z.infer<typeof saveRecordSchema>;
export type NotificationRecord = z.infer<typeof notificationRecordSchema>;
export type PrefsRecord = z.infer<typeof prefsRecordSchema>;
export type ModlogRecord = z.infer<typeof modlogRecordSchema>;
/** A replicated record of any kind. */
export type StoredRecord = z.infer<typeof storedRecordSchema>;
export type RecordKind = StoredRecord["kind"];

export type SpaceMutatorName = keyof typeof spaceMutators;
export type SpaceMutatorInput<Name extends SpaceMutatorName> = z.input<
  (typeof spaceMutators)[Name]["input"]
>;
export type SpaceMutatorResult<Name extends SpaceMutatorName> = z.output<
  (typeof spaceMutators)[Name]["result"]
>;
export type SpaceOnlineProcedureName = keyof typeof spaceOnlineProcedures;

export type SpaceRunDelta = z.infer<typeof spaceRunDeltaSchema>;

export type UserStatus = z.infer<typeof userStatusSchema>;
export type UserProvider = z.infer<typeof userProviderSchema>;
export type AccountInvite = z.infer<typeof accountInviteSchema>;

export type SpaceErrorCode = z.infer<typeof spaceErrorCodeSchema>;
export type SpaceRefusalReason = z.infer<typeof spaceRefusalReasonSchema>;
export type SpaceError = z.infer<typeof spaceErrorSchema>;
