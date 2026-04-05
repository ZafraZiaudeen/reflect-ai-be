import { randomUUID } from 'node:crypto';
import type { CoupleDocument } from '../domain/Models/Couple.js';
import { SessionModel } from '../domain/Models/Session.js';
import {
  buildDefaultHomework,
  inferCoreConflict,
  inferObservedPatterns,
  isMeaningfulSessionAttempt,
  selectTranscriptAlignedHomeworkAssignments,
} from '../domain/Rules/sessionRules.js';
import type {
  ActiveHomeworkGateSummary,
  HomeworkGate,
  HomeworkGateAssignment,
  HomeworkReflection,
  InterventionEvent,
  PartnerRole,
  TranscriptSegment,
} from '../domain/Types/mirror.js';

const PARTNER_ROLES: PartnerRole[] = ['partner_a', 'partner_b'];

const normalizeText = (value: string | undefined, fallback: string): string => value?.trim() || fallback;

const toComparableJson = (value: unknown): string => JSON.stringify(value);

const getSubmittedAtTime = (reflection?: HomeworkReflection | null): number =>
  reflection?.submittedAt ? new Date(reflection.submittedAt).getTime() : 0;

const sortByLatestSubmission = (left?: HomeworkReflection | null, right?: HomeworkReflection | null): number =>
  getSubmittedAtTime(right) - getSubmittedAtTime(left);

const cloneSubmission = (submission?: HomeworkReflection | null): HomeworkReflection | null => {
  if (!submission?.submittedAt) {
    return null;
  }

  return {
    userId: submission.userId,
    completed: submission.completed,
    reflection: submission.reflection,
    submittedAt: new Date(submission.submittedAt),
  };
};

const getParticipantRoles = (couple: CoupleDocument): PartnerRole[] =>
  couple.partnerBUserId ? [...PARTNER_ROLES] : ['partner_a'];

export const getPartnerRoleForUser = (
  couple: CoupleDocument,
  userId: string,
): PartnerRole | null => {
  if (couple.partnerAUserId === userId) {
    return 'partner_a';
  }

  if (couple.partnerBUserId === userId) {
    return 'partner_b';
  }

  return null;
};

export const getPartnerUserId = (
  couple: CoupleDocument,
  role: PartnerRole,
): string | undefined => (role === 'partner_a' ? couple.partnerAUserId : couple.partnerBUserId);

export const getPartnerDisplayName = (
  couple: CoupleDocument,
  role: PartnerRole,
): string => (role === 'partner_a' ? couple.partnerAName : couple.partnerBName || 'Partner B');

const buildFallbackAssignment = (
  couple: CoupleDocument,
  role: PartnerRole,
): HomeworkGateAssignment => {
  const displayName = getPartnerDisplayName(couple, role);
  const prompt =
    role === 'partner_a'
      ? 'What specific thing did you do or say in the last session that made the conflict worse, and what truth about your own role are you still avoiding?'
      : 'What moment from the last session shows the clearest example of your pattern, and what were you really feeling underneath that reaction?';

  return {
    id: randomUUID(),
    title: `${displayName}'s reflection`,
    description: 'Write one direct reflection about your own part in the last session before the next room opens.',
    reflectionPrompt: prompt,
    targetPartnerRole: role,
    submission: null,
  };
};

const pickLatestLegacySubmission = (
  assignment: HomeworkGateAssignment,
  userId?: string,
): HomeworkReflection | null => {
  if (!userId) {
    return null;
  }

  const candidates = [
    assignment.submission?.userId === userId ? assignment.submission : null,
    ...(assignment.reflections ?? []).filter((reflection) => reflection.userId === userId),
  ]
    .filter(Boolean)
    .map((reflection) => cloneSubmission(reflection as HomeworkReflection))
    .filter((reflection): reflection is HomeworkReflection => Boolean(reflection))
    .sort(sortByLatestSubmission);

  return candidates[0] ?? null;
};

const buildNormalizedAssignment = (args: {
  role: PartnerRole;
  couple: CoupleDocument;
  sourceAssignment?: HomeworkGateAssignment;
  submission?: HomeworkReflection | null;
}): HomeworkGateAssignment => {
  const fallback = buildFallbackAssignment(args.couple, args.role);

  return {
    id: normalizeText(args.sourceAssignment?.id, fallback.id),
    title: normalizeText(args.sourceAssignment?.title, fallback.title),
    description: normalizeText(args.sourceAssignment?.description, fallback.description),
    reflectionPrompt: normalizeText(args.sourceAssignment?.reflectionPrompt, fallback.reflectionPrompt),
    targetPartnerRole: args.role,
    submission: cloneSubmission(args.submission) ?? null,
  };
};

const selectAssignmentForRole = (args: {
  role: PartnerRole;
  couple: CoupleDocument;
  assignments: HomeworkGateAssignment[];
  usedAssignmentIds: Set<string>;
}): HomeworkGateAssignment => {
  const { role, couple, assignments, usedAssignmentIds } = args;
  const targetUserId = getPartnerUserId(couple, role);

  const targetedCandidates = assignments
    .filter((assignment) => assignment.targetPartnerRole === role)
    .map((assignment) => ({
      assignment,
      submission: pickLatestLegacySubmission(assignment, targetUserId),
    }));
  const targetedWithSubmission = targetedCandidates
    .filter((candidate) => Boolean(candidate.submission))
    .sort((left, right) => sortByLatestSubmission(left.submission, right.submission));

  if (targetedWithSubmission[0]) {
    usedAssignmentIds.add(targetedWithSubmission[0].assignment.id);
    return buildNormalizedAssignment({
      role,
      couple,
      sourceAssignment: targetedWithSubmission[0].assignment,
      submission: targetedWithSubmission[0].submission,
    });
  }

  if (targetedCandidates[0]) {
    usedAssignmentIds.add(targetedCandidates[0].assignment.id);
    return buildNormalizedAssignment({
      role,
      couple,
      sourceAssignment: targetedCandidates[0].assignment,
      submission: targetedCandidates[0].submission,
    });
  }

  const legacyCandidates = assignments
    .map((assignment) => ({
      assignment,
      submission: pickLatestLegacySubmission(assignment, targetUserId),
    }))
    .filter((candidate) => Boolean(candidate.submission))
    .sort((left, right) => sortByLatestSubmission(left.submission, right.submission));

  if (legacyCandidates[0]) {
    usedAssignmentIds.add(legacyCandidates[0].assignment.id);
    return buildNormalizedAssignment({
      role,
      couple,
      sourceAssignment: legacyCandidates[0].assignment,
      submission: legacyCandidates[0].submission,
    });
  }

  const nextAvailableLegacyAssignment = assignments.find(
    (assignment) => !usedAssignmentIds.has(assignment.id),
  );

  if (nextAvailableLegacyAssignment) {
    usedAssignmentIds.add(nextAvailableLegacyAssignment.id);
    return buildNormalizedAssignment({
      role,
      couple,
      sourceAssignment: nextAvailableLegacyAssignment,
      submission: null,
    });
  }

  return buildFallbackAssignment(couple, role);
};

const buildFallbackAssignmentsByRole = (
  transcriptSegments: TranscriptSegment[],
  interventions: InterventionEvent[],
): Map<PartnerRole, HomeworkGateAssignment> => {
  const fallbackAssignments = buildDefaultHomework(
    inferCoreConflict(transcriptSegments),
    inferObservedPatterns(transcriptSegments, interventions),
    transcriptSegments,
  );

  return new Map(
    fallbackAssignments.map((assignment) => [
      assignment.targetPartnerRole,
      {
        ...assignment,
        submission: null,
      },
    ]),
  );
};

const repairNormalizedHomeworkGate = (args: {
  couple: CoupleDocument;
  gate: HomeworkGate;
  sourceAssignments: HomeworkGateAssignment[];
  transcriptSegments: TranscriptSegment[];
  interventions: InterventionEvent[];
}): { gate: HomeworkGate; changed: boolean } => {
  const { couple, gate, sourceAssignments, transcriptSegments, interventions } = args;
  const before = toComparableJson(gate);
  const roles = getParticipantRoles(couple);
  const selectedSources = selectTranscriptAlignedHomeworkAssignments(sourceAssignments, transcriptSegments);
  const fallbackByRole = buildFallbackAssignmentsByRole(transcriptSegments, interventions);
  const repairedAssignments = roles.map((role) => {
    const currentAssignment =
      gate.assignments.find((assignment) => assignment.targetPartnerRole === role) ??
      buildFallbackAssignment(couple, role);
    const selected = selectedSources[role]?.normalized;
    const fallback = fallbackByRole.get(role) ?? buildFallbackAssignment(couple, role);
    const useSelectedMeta = selected?.targetPartnerRole === role;

    return {
      id: normalizeText(currentAssignment.id, fallback.id),
      title: normalizeText(useSelectedMeta ? selected?.title : undefined, fallback.title),
      description: normalizeText(useSelectedMeta ? selected?.description : undefined, fallback.description),
      reflectionPrompt: normalizeText(selected?.reflectionPrompt, fallback.reflectionPrompt),
      targetPartnerRole: role,
      submission: cloneSubmission(currentAssignment.submission) ?? null,
    };
  });
  const allSubmitted = repairedAssignments.every((assignment) => Boolean(assignment.submission?.submittedAt));
  const latestSubmittedAt = repairedAssignments
    .map((assignment) => assignment.submission?.submittedAt)
    .filter((submittedAt): submittedAt is Date => Boolean(submittedAt))
    .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] ?? null;

  const repairedGate: HomeworkGate = {
    sourceSessionId: gate.sourceSessionId,
    createdAt: new Date(gate.createdAt),
    assignments: repairedAssignments,
    requiredReflections: roles.length,
    unlockedAt: allSubmitted ? gate.unlockedAt ?? latestSubmittedAt : null,
  };

  return {
    gate: repairedGate,
    changed: before !== toComparableJson(repairedGate),
  };
};

const mapHomeworkGateSummary = (
  couple: CoupleDocument,
  userId: string,
  gate: HomeworkGate,
): ActiveHomeworkGateSummary | null => {
  const viewerRole = getPartnerRoleForUser(couple, userId);
  if (!viewerRole) {
    return null;
  }

  const partnerRole = viewerRole === 'partner_a' ? 'partner_b' : 'partner_a';
  const myAssignment = gate.assignments.find((assignment) => assignment.targetPartnerRole === viewerRole) ?? null;
  const partnerAssignment =
    couple.partnerBUserId
      ? gate.assignments.find((assignment) => assignment.targetPartnerRole === partnerRole) ?? null
      : null;

  return {
    sourceSessionId: gate.sourceSessionId,
    createdAt: gate.createdAt,
    myAssignment: myAssignment
      ? {
          id: myAssignment.id,
          title: myAssignment.title,
          description: myAssignment.description,
          reflectionPrompt: myAssignment.reflectionPrompt,
          targetPartnerRole: myAssignment.targetPartnerRole,
          submission: myAssignment.submission
            ? {
                completed: myAssignment.submission.completed,
                reflection: myAssignment.submission.reflection,
                submittedAt: myAssignment.submission.submittedAt,
              }
            : null,
        }
      : null,
    partnerStatus: partnerAssignment
      ? {
          targetPartnerRole: partnerRole,
          displayName: getPartnerDisplayName(couple, partnerRole),
          hasSubmitted: Boolean(partnerAssignment.submission?.submittedAt),
          completed: partnerAssignment.submission?.completed ?? false,
          submittedAt: partnerAssignment.submission?.submittedAt ?? null,
        }
      : null,
    requiredReflections: gate.requiredReflections,
    submittedCount: gate.assignments.filter((assignment) => Boolean(assignment.submission?.submittedAt)).length,
    unlockedAt: gate.unlockedAt ?? null,
  };
};

export const normalizeHomeworkGateForCouple = (
  couple: CoupleDocument,
): { gate: HomeworkGate | null; changed: boolean } => {
  const currentGate = couple.activeHomeworkGate;
  if (!currentGate) {
    return { gate: null, changed: false };
  }

  const before = toComparableJson(currentGate);
  const roles = getParticipantRoles(couple);
  const assignments = [...(currentGate.assignments ?? [])];
  const usedAssignmentIds = new Set<string>();
  const normalizedAssignments = roles.map((role) =>
    selectAssignmentForRole({
      role,
      couple,
      assignments,
      usedAssignmentIds,
    }),
  );
  const allSubmitted = normalizedAssignments.every((assignment) => Boolean(assignment.submission?.submittedAt));
  const latestSubmittedAt = normalizedAssignments
    .map((assignment) => assignment.submission?.submittedAt)
    .filter((submittedAt): submittedAt is Date => Boolean(submittedAt))
    .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] ?? null;

  const normalizedGate: HomeworkGate = {
    sourceSessionId: currentGate.sourceSessionId,
    createdAt: new Date(currentGate.createdAt),
    assignments: normalizedAssignments,
    requiredReflections: roles.length,
    unlockedAt: allSubmitted ? currentGate.unlockedAt ?? latestSubmittedAt : null,
  };

  const changed = before !== toComparableJson(normalizedGate);

  if (changed) {
    couple.activeHomeworkGate = normalizedGate;
  }

  return {
    gate: changed ? normalizedGate : (currentGate as HomeworkGate),
    changed,
  };
};

export const ensureHomeworkGateIntegrity = async (
  couple: CoupleDocument,
): Promise<{ gate: HomeworkGate | null; changed: boolean }> => {
  const currentGate = couple.activeHomeworkGate;
  if (!currentGate) {
    return { gate: null, changed: false };
  }

  const sourceAssignments = [...(currentGate.assignments ?? [])];
  const sourceSession = await SessionModel.findById(currentGate.sourceSessionId);
  if (!sourceSession) {
    couple.activeHomeworkGate = null;
    return { gate: null, changed: true };
  }

  const isMeaningful = isMeaningfulSessionAttempt({
    transcriptSegments: sourceSession.transcriptSegments,
    interventions: sourceSession.interventions,
    metrics: sourceSession.metrics,
  });
  if (!isMeaningful) {
    couple.activeHomeworkGate = null;
    return { gate: null, changed: true };
  }

  const normalized = normalizeHomeworkGateForCouple(couple);
  let gate = normalized.gate;
  let changed = normalized.changed;

  if (!gate) {
    return { gate: null, changed };
  }

  const repaired = repairNormalizedHomeworkGate({
    couple,
    gate,
    sourceAssignments: sourceAssignments.length > 0 ? sourceAssignments : gate.assignments,
    transcriptSegments: sourceSession.transcriptSegments,
    interventions: sourceSession.interventions,
  });

  if (repaired.changed) {
    couple.activeHomeworkGate = repaired.gate;
    gate = repaired.gate;
    changed = true;
  }

  return { gate, changed };
};

export const mapHomeworkGateSummaryForUser = (
  couple: CoupleDocument,
  userId: string,
  gateOverride?: HomeworkGate | null,
): ActiveHomeworkGateSummary | null => {
  const gate = gateOverride ?? normalizeHomeworkGateForCouple(couple).gate;
  if (!gate) {
    return null;
  }

  return mapHomeworkGateSummary(couple, userId, gate);
};
