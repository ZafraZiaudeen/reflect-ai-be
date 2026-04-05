import { randomUUID } from 'node:crypto';
const PARTNER_ROLES = ['partner_a', 'partner_b'];
const CONFLICT_KEYWORDS = [
    { label: 'financial transparency', words: ['money', 'debt', 'spending', 'budget', 'rent', 'bill'] },
    { label: 'trust and honesty', words: ['trust', 'lie', 'hid', 'truth', 'honest', 'secret'] },
    { label: 'emotional responsiveness', words: ['ignored', 'listen', 'heard', 'dismiss', 'cold'] },
    { label: 'division of effort', words: ['help', 'house', 'kids', 'work', 'load', 'responsibility'] },
    { label: 'intimacy and connection', words: ['close', 'affection', 'intimacy', 'sex', 'distance'] },
];
const PATTERN_RULES = [
    { label: 'defensiveness', test: /(not my fault|you started|that's because you|i only did that because)/i },
    { label: 'criticism', test: /\b(always|never)\b/i },
    { label: 'stonewalling', test: /(whatever|i'm done|leave me alone|i don't care)/i },
    { label: 'contempt', test: /(ridiculous|pathetic|crazy|embarrassing|disgusting)/i },
];
const HOMEWORK_STOPWORDS = new Set([
    'a',
    'about',
    'after',
    'all',
    'also',
    'an',
    'and',
    'any',
    'are',
    'around',
    'because',
    'before',
    'between',
    'both',
    'but',
    'change',
    'described',
    'describe',
    'describing',
    'did',
    'does',
    'focus',
    'for',
    'from',
    'had',
    'have',
    'how',
    'incident',
    'into',
    'label',
    'moment',
    'more',
    'not',
    'only',
    'other',
    'partner',
    'party',
    'prompt',
    'question',
    'reflect',
    'reflection',
    'said',
    'specific',
    'than',
    'that',
    'the',
    'their',
    'them',
    'then',
    'there',
    'these',
    'they',
    'this',
    'those',
    'through',
    'what',
    'when',
    'where',
    'which',
    'while',
    'write',
    'you',
    'your',
]);
const HOMEWORK_ROLE_REFERENCES = {
    partner_a: ['partner a', 'party a'],
    partner_b: ['partner b', 'party b'],
};
const countWords = (value) => value
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
const collapseWhitespace = (value) => value.replace(/\s+/g, ' ').trim();
const normalizeLooseText = (value) => collapseWhitespace(value.toLowerCase().replace(/[^a-z0-9\s]/g, ' '));
const tokenizeHomeworkText = (value) => {
    const tokens = normalizeLooseText(value)
        .split(' ')
        .filter((token) => token.length >= 3 && !HOMEWORK_STOPWORDS.has(token));
    return [...new Set(tokens)];
};
const clipQuote = (value, maxLength = 120) => {
    const normalized = collapseWhitespace(value);
    if (normalized.length <= maxLength) {
        return normalized;
    }
    return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
};
const getDefaultSpeakerLabel = (role) => role === 'partner_a' ? 'Partner A' : 'Partner B';
const getLatestPartnerQuote = (transcriptSegments, role) => {
    for (let index = transcriptSegments.length - 1; index >= 0; index -= 1) {
        const segment = transcriptSegments[index];
        if (segment.speakerRole === role && segment.text.trim()) {
            return {
                speakerLabel: segment.speakerLabel,
                text: clipQuote(segment.text),
            };
        }
    }
    return null;
};
const buildHomeworkRoleEvidenceMap = (transcriptSegments) => {
    const toEvidence = (role) => {
        const partnerTurns = transcriptSegments.filter((segment) => segment.speakerRole === role && segment.text.trim());
        const meaningfulTurns = partnerTurns.filter((segment) => countWords(segment.text) >= 2);
        const turnsForEvidence = meaningfulTurns.length > 0 ? meaningfulTurns : partnerTurns;
        const latestTurn = turnsForEvidence[turnsForEvidence.length - 1] ?? null;
        const recentQuotes = turnsForEvidence.slice(-4).map((segment) => clipQuote(segment.text));
        const normalizedTurns = turnsForEvidence.map((segment) => normalizeLooseText(segment.text)).filter(Boolean);
        const tokenSet = new Set();
        for (const segment of turnsForEvidence) {
            for (const token of tokenizeHomeworkText(segment.text)) {
                tokenSet.add(token);
            }
        }
        const speakerLabel = latestTurn?.speakerLabel?.trim() || getDefaultSpeakerLabel(role);
        return {
            role,
            speakerLabel,
            normalizedSpeakerLabel: normalizeLooseText(speakerLabel),
            recentQuotes,
            latestMeaningfulUtterance: recentQuotes[recentQuotes.length - 1] ?? null,
            tokenSet,
            normalizedTurns,
        };
    };
    return {
        partner_a: toEvidence('partner_a'),
        partner_b: toEvidence('partner_b'),
    };
};
const extractQuotedPhrases = (value) => {
    const phrases = [
        ...Array.from(value.matchAll(/"([^"\n]{3,180})"/g), (match) => match[1]),
        ...Array.from(value.matchAll(/'([^'\n]{3,180})'/g), (match) => match[1]),
    ]
        .map((phrase) => collapseWhitespace(phrase))
        .filter(Boolean);
    return [...new Set(phrases)];
};
const scoreQuotedPhraseMatch = (phrase, evidence, otherEvidence) => {
    const normalizedPhrase = normalizeLooseText(phrase);
    if (!normalizedPhrase) {
        return 0;
    }
    let score = 0;
    const phraseTokens = tokenizeHomeworkText(phrase);
    const ownOverlap = phraseTokens.filter((token) => evidence.tokenSet.has(token)).length;
    const otherOverlap = phraseTokens.filter((token) => otherEvidence.tokenSet.has(token)).length;
    if (evidence.normalizedTurns.some((turn) => turn.includes(normalizedPhrase))) {
        score += 8;
    }
    else if (ownOverlap > 0) {
        score += Math.min(4, ownOverlap * 2);
    }
    if (otherEvidence.normalizedTurns.some((turn) => turn.includes(normalizedPhrase))) {
        score -= 8;
    }
    else if (otherOverlap > 0) {
        score -= Math.min(4, otherOverlap * 2);
    }
    return score;
};
const computeHomeworkSemanticScore = (assignmentText, role, evidenceByRole) => {
    const normalizedText = normalizeLooseText(assignmentText);
    if (!normalizedText) {
        return 0;
    }
    const evidence = evidenceByRole[role];
    const otherRole = role === 'partner_a' ? 'partner_b' : 'partner_a';
    const otherEvidence = evidenceByRole[otherRole];
    let score = 0;
    if (evidence.normalizedSpeakerLabel && normalizedText.includes(evidence.normalizedSpeakerLabel)) {
        score += 6;
    }
    if (otherEvidence.normalizedSpeakerLabel && normalizedText.includes(otherEvidence.normalizedSpeakerLabel)) {
        score -= 6;
    }
    for (const reference of HOMEWORK_ROLE_REFERENCES[role]) {
        if (normalizedText.includes(reference)) {
            score += 4;
        }
    }
    for (const reference of HOMEWORK_ROLE_REFERENCES[otherRole]) {
        if (normalizedText.includes(reference)) {
            score -= 4;
        }
    }
    const promptTokens = tokenizeHomeworkText(assignmentText);
    const ownOverlap = promptTokens.filter((token) => evidence.tokenSet.has(token)).length;
    const otherOverlap = promptTokens.filter((token) => otherEvidence.tokenSet.has(token)).length;
    score += Math.min(6, ownOverlap);
    score -= Math.min(6, otherOverlap);
    for (const phrase of extractQuotedPhrases(assignmentText)) {
        score += scoreQuotedPhraseMatch(phrase, evidence, otherEvidence);
    }
    return score;
};
const getReliableHomeworkRole = (semanticScoreByRole) => {
    const partnerAScore = semanticScoreByRole.partner_a;
    const partnerBScore = semanticScoreByRole.partner_b;
    if (partnerAScore >= 3 && partnerAScore >= partnerBScore + 2) {
        return 'partner_a';
    }
    if (partnerBScore >= 3 && partnerBScore >= partnerAScore + 2) {
        return 'partner_b';
    }
    return null;
};
const analyzeHomeworkAssignments = (assignments, transcriptSegments) => {
    const evidenceByRole = buildHomeworkRoleEvidenceMap(transcriptSegments);
    return assignments.map((assignment, index) => {
        const normalized = {
            id: assignment.id?.trim() || undefined,
            title: assignment.title?.trim() || '',
            description: assignment.description?.trim() || '',
            reflectionPrompt: assignment.reflectionPrompt?.trim() || '',
            targetPartnerRole: assignment.targetPartnerRole,
        };
        const combinedText = [
            normalized.title,
            normalized.description,
            normalized.reflectionPrompt,
        ]
            .filter(Boolean)
            .join(' ');
        const semanticScoreByRole = {
            partner_a: computeHomeworkSemanticScore(combinedText, 'partner_a', evidenceByRole),
            partner_b: computeHomeworkSemanticScore(combinedText, 'partner_b', evidenceByRole),
        };
        const totalScoreByRole = {
            partner_a: semanticScoreByRole.partner_a + (normalized.targetPartnerRole === 'partner_a' ? 1 : 0),
            partner_b: semanticScoreByRole.partner_b + (normalized.targetPartnerRole === 'partner_b' ? 1 : 0),
        };
        return {
            assignment,
            index,
            normalized,
            semanticScoreByRole,
            totalScoreByRole,
            reliableRole: getReliableHomeworkRole(semanticScoreByRole),
        };
    });
};
export const selectTranscriptAlignedHomeworkAssignments = (assignments, transcriptSegments) => {
    const analyses = analyzeHomeworkAssignments(assignments, transcriptSegments);
    const selections = {};
    const usedIndices = new Set();
    for (const role of PARTNER_ROLES) {
        const selected = analyses
            .filter((analysis) => analysis.reliableRole === role && !usedIndices.has(analysis.index))
            .sort((left, right) => {
            const semanticDiff = right.semanticScoreByRole[role] - left.semanticScoreByRole[role];
            if (semanticDiff !== 0) {
                return semanticDiff;
            }
            const totalDiff = right.totalScoreByRole[role] - left.totalScoreByRole[role];
            if (totalDiff !== 0) {
                return totalDiff;
            }
            const rightHasTargetHint = right.normalized.targetPartnerRole === role ? 1 : 0;
            const leftHasTargetHint = left.normalized.targetPartnerRole === role ? 1 : 0;
            return rightHasTargetHint - leftHasTargetHint;
        })[0];
        if (selected) {
            selections[role] = selected;
            usedIndices.add(selected.index);
        }
    }
    return selections;
};
export const buildHomeworkAttributionGuidance = (transcriptSegments) => {
    const evidenceByRole = buildHomeworkRoleEvidenceMap(transcriptSegments);
    return PARTNER_ROLES.map((role) => ({
        targetPartnerRole: role,
        speakerLabel: evidenceByRole[role].speakerLabel,
        latestMeaningfulUtterance: evidenceByRole[role].latestMeaningfulUtterance,
        recentQuotes: evidenceByRole[role].recentQuotes,
    }));
};
export const createInviteCode = () => randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
export const getSessionStartBlocker = (gate) => {
    if (!gate) {
        return null;
    }
    const missingReflections = gate.assignments.some((assignment) => !assignment.submission?.submittedAt);
    return missingReflections
        ? 'Both partners must submit the current homework reflection before the next session can open.'
        : null;
};
export const summarizeHomeworkGate = (gate) => {
    if (!gate) {
        return 'No active homework gate. The couple can open a new session when both partners are ready.';
    }
    return gate.assignments
        .map((assignment) => `${assignment.title} (${assignment.submission?.submittedAt ? 'submitted' : 'awaiting response'})`)
        .join(' | ');
};
export const inferObservedPatterns = (transcriptSegments, interventions) => {
    const joined = transcriptSegments.map((segment) => segment.text).join(' ').toLowerCase();
    const patterns = new Set();
    for (const rule of PATTERN_RULES) {
        if (rule.test.test(joined)) {
            patterns.add(rule.label);
        }
    }
    if (interventions.length > 0) {
        patterns.add('circular escalation');
    }
    if (patterns.size === 0) {
        patterns.add('emotional flooding');
    }
    return [...patterns];
};
export const inferCoreConflict = (transcriptSegments) => {
    const joined = transcriptSegments.map((segment) => segment.text).join(' ').toLowerCase();
    const scored = CONFLICT_KEYWORDS
        .map((entry) => ({
        label: entry.label,
        score: entry.words.reduce((total, word) => total + (joined.includes(word) ? 1 : 0), 0),
    }))
        .sort((left, right) => right.score - left.score);
    return scored[0]?.score
        ? `Recurring conflict around ${scored[0].label}`
        : 'Breakdown in accountability and emotional safety';
};
/**
 * Build fallback homework when the LLM fails to generate dynamic prompts.
 * These are still tailored to the core conflict rather than being fully static.
 */
export const buildDefaultHomework = (coreConflict, observedPatterns = [], transcriptSegments = []) => {
    const patternClause = observedPatterns.length > 0
        ? ` The patterns observed were: ${observedPatterns.join(', ')}.`
        : '';
    const partnerAQuote = getLatestPartnerQuote(transcriptSegments, 'partner_a');
    const partnerBQuote = getLatestPartnerQuote(transcriptSegments, 'partner_b');
    const partnerAPrompt = partnerAQuote
        ? `${partnerAQuote.speakerLabel}, you said "${partnerAQuote.text}". What were you defending or minimizing in that moment, and how did it make the conflict worse?`
        : `Thinking about the ${coreConflict.toLowerCase()} discussed in this session: What specific thing did YOU do or say that made things worse? Do not mention your partner - only your own actions.`;
    const partnerBPrompt = partnerBQuote
        ? `${partnerBQuote.speakerLabel}, when you said "${partnerBQuote.text}", what truth about your own role were you trying not to face? What were you actually feeling underneath the reaction?`
        : 'Name one specific moment from this session where you were not being fully honest or accountable. What were you actually feeling underneath the reaction?';
    return [
        {
            id: randomUUID(),
            title: 'Partner A accountability',
            description: `Partner A writes one paragraph naming their specific part in the ${coreConflict.toLowerCase()}.${patternClause}`,
            reflectionPrompt: partnerAPrompt,
            targetPartnerRole: 'partner_a',
        },
        {
            id: randomUUID(),
            title: 'Partner B accountability',
            description: `Partner B identifies one moment from this session where they fell into a destructive pattern${patternClause ? ` (${observedPatterns.join(', ')})` : ''} and describes what they could have done instead.`,
            reflectionPrompt: partnerBPrompt,
            targetPartnerRole: 'partner_b',
        },
    ];
};
export const clampHonestyScore = (value) => Math.max(1, Math.min(100, Math.round(value)));
export const buildFallbackTruthReport = (transcriptSegments, interventions, previousSummary) => {
    const coreConflict = inferCoreConflict(transcriptSegments);
    const observedPatterns = inferObservedPatterns(transcriptSegments, interventions);
    const honestyScore = clampHonestyScore(78 -
        interventions.length * 8 -
        (observedPatterns.includes('criticism') ? 10 : 0) -
        (observedPatterns.includes('contempt') ? 15 : 0));
    const truthSummary = previousSummary
        ? `The couple is revisiting a known pattern: ${previousSummary}. They still shift into ${observedPatterns.join(', ')} instead of staying accountable.`
        : `The session centered on ${coreConflict.toLowerCase()}. The main issue was not lack of feeling, but lack of clean accountability.`;
    return {
        coreConflict,
        truthSummary,
        observedPatterns,
        homework: buildDefaultHomework(coreConflict, observedPatterns, transcriptSegments),
        nextGoal: 'Return with evidence that both partners can name their contribution without immediately counterattacking.',
        honestyScore,
        clinicalFrame: 'Direct professional',
    };
};
export const normalizeTruthReport = (rawReport, transcriptSegments, interventions, previousSummary) => {
    const fallback = buildFallbackTruthReport(transcriptSegments, interventions, previousSummary);
    const fallbackByRole = new Map(fallback.homework.map((assignment) => [assignment.targetPartnerRole, assignment]));
    const rawHomework = Array.isArray(rawReport.homework) ? rawReport.homework : [];
    const selectedAssignments = selectTranscriptAlignedHomeworkAssignments(rawHomework, transcriptSegments);
    const homework = PARTNER_ROLES.map((role) => {
        const selected = selectedAssignments[role]?.normalized;
        const roleFallback = fallbackByRole.get(role);
        return {
            id: selected?.id || roleFallback?.id || randomUUID(),
            title: selected?.title || roleFallback?.title || 'Practice direct accountability',
            description: selected?.description ||
                roleFallback?.description ||
                'Return with one concrete example of changed behavior.',
            reflectionPrompt: selected?.reflectionPrompt ||
                roleFallback?.reflectionPrompt ||
                'What part of your own pattern are you still trying to excuse?',
            targetPartnerRole: role,
        };
    });
    return {
        coreConflict: rawReport.coreConflict?.trim() || fallback.coreConflict,
        truthSummary: rawReport.truthSummary?.trim() || fallback.truthSummary,
        observedPatterns: rawReport.observedPatterns?.filter((pattern) => Boolean(pattern && pattern.trim())) ?? fallback.observedPatterns,
        homework,
        nextGoal: rawReport.nextGoal?.trim() || fallback.nextGoal,
        honestyScore: clampHonestyScore(rawReport.honestyScore ?? fallback.honestyScore),
        clinicalFrame: rawReport.clinicalFrame?.trim() || fallback.clinicalFrame,
    };
};
export const buildSessionContextSummary = (previousSummary, gate) => {
    const parts = [];
    if (previousSummary) {
        parts.push(`Previous session memory: ${previousSummary}`);
    }
    else {
        parts.push("This is the couple's first session - no prior session memory exists yet.");
    }
    const gateSummary = summarizeHomeworkGate(gate);
    parts.push(`Homework gate status: ${gateSummary}`);
    if (gate?.assignments) {
        for (const assignment of gate.assignments) {
            if (assignment.submission?.submittedAt) {
                parts.push(`Homework "${assignment.title}":`);
                parts.push(`  - ${assignment.targetPartnerRole} reflection (completed: ${assignment.submission.completed}): "${assignment.submission.reflection}"`);
            }
        }
    }
    return parts.join('\n');
};
export const isMeaningfulSessionAttempt = (args) => {
    const conversationalTurns = args.transcriptSegments.filter((segment) => segment.source !== 'system');
    const partnerTurns = conversationalTurns.filter((segment) => segment.source === 'frontend-webspeech' || segment.source === 'livekit-user');
    const mirrorTurns = conversationalTurns.filter((segment) => segment.source === 'agent-livekit');
    const partnerWordCount = partnerTurns.reduce((total, segment) => total + countWords(segment.text), 0);
    const totalWordCount = conversationalTurns.reduce((total, segment) => total + countWords(segment.text), 0);
    if (partnerTurns.length >= 2 && totalWordCount >= 24) {
        return true;
    }
    if (partnerTurns.length >= 1 && mirrorTurns.length >= 1 && totalWordCount >= 18) {
        return true;
    }
    if (args.interventions.length >= 2 && partnerWordCount >= 12) {
        return true;
    }
    return false;
};
