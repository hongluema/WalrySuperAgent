export type TutorPhase =
  | "idle"
  | "research"
  | "diagnose"
  | "plan"
  | "teach"
  | "complete";

export type LearningSessionStatus = "active" | "paused" | "completed";

export type MacroDomain =
  | "formal-sciences"
  | "natural-and-health-sciences"
  | "computing-and-engineering"
  | "social-and-behavioral-sciences"
  | "business-economics-and-law"
  | "humanities"
  | "language-and-communication"
  | "arts-and-design"
  | "life-and-work-practice";

export type KnowledgeType =
  | "factual"
  | "conceptual"
  | "causal"
  | "procedural"
  | "formal"
  | "strategic"
  | "language"
  | "argument";

export type DomainPackId =
  | "generic"
  | "formal-stem"
  | "software-engineering"
  | "language-communication"
  | "argument-case"
  | "high-risk-policy";

export type SubjectClassification = {
  macroDomain: MacroDomain;
  subdomainPath: string[];
  secondaryDomains: MacroDomain[];
  confidence: number;
  source: "inferred" | "user-corrected";
  version: string;
};

export type SubjectCorrection = {
  macroDomain: MacroDomain;
  subdomainPath?: string[];
  secondaryDomains?: MacroDomain[];
};

export type ClientTutorCommand = {
  type: "UPDATE_SUBJECT";
  correction: SubjectCorrection;
};

export type LearningSessionSummary = {
  learningSessionId: string;
  topic?: string;
  lessonTitle?: string;
  status: LearningSessionStatus;
  updatedAt: string;
};

export type LearnerResponseIntent =
  | "answer"
  | "dont_know"
  | "no_doubts"
  | "disagreement"
  | "clarification"
  | "direct_answer_request"
  | "topic_switch"
  | "meta_question"
  | "stop";

/** @deprecated 使用 LearnerResponseIntent；保留别名以兼容现有状态文件与调用方。 */
export type TutorTurnIntent = LearnerResponseIntent;

/** 用户这一轮想做什么；与答案证据意图 TutorTurnIntent 分开。 */
export type UserIntent =
  | "START_LEARNING"
  | "ASK_QUESTION"
  | "REQUEST_EXPLANATION"
  | "REQUEST_EXAMPLE"
  | "REQUEST_HINT"
  | "REQUEST_PRACTICE"
  | "REQUEST_ASSESSMENT"
  | "SUBMIT_ANSWER"
  | "REPORT_CONFUSION"
  | "CHALLENGE_FEEDBACK"
  | "CHANGE_GOAL"
  | "PAUSE"
  | "RESUME"
  | "STOP";

export type SessionCommand = "NONE" | "CREATE" | "CONTINUE" | "MODIFY" | "SWITCH" | "PAUSE" | "RESUME" | "END";

export type PedagogicalAction =
  | "CLARIFY_GOAL"
  | "BUILD_PLAN"
  | "DIAGNOSE"
  | "EXPLAIN"
  | "DEMONSTRATE"
  | "GUIDED_PRACTICE"
  | "INDEPENDENT_PRACTICE"
  | "GIVE_HINT"
  | "ASSESS"
  | "REPAIR"
  | "REVIEW"
  | "TRANSFER"
  | "COMPLETE";

export type TurnResolution = {
  target: "tutor" | "generic";
  mode: "quick" | "course";
  intents: Array<{ type: UserIntent; confidence: number }>;
  primaryIntent: UserIntent;
  sessionCommand: SessionCommand;
  requestedTopic?: string;
  explicitAction?: PedagogicalAction;
  confidence: number;
  reasonCodes: string[];
  policyVersion: string;
};

export type TopicRubricAnchor = {
  conceptId: string;
  accuracy: string;
  explanation: string;
  discrimination: string;
  transfer: string;
  performance?: string;
};

export type LearningCapabilityPlan = {
  acquisition: string[];
  structuring: string[];
  interaction: string[];
  assessment: string[];
  missing: string[];
};

export type EvidenceCriterion = "accurate" | "explained" | "discrimination" | "transfer" | "performance";

export type LearningEvidence = {
  learnerQuote: string;
  criterion: EvidenceCriterion;
  strength: "weak" | "sufficient";
  confidence?: number;
};

export type MisconceptionUpdate = {
  description: string;
  status: "open" | "repaired";
  evidenceQuote: string;
};

export type QuestionPurpose = EvidenceCriterion | "introduce" | "doubt-check";

export type DiagnosticKind = "baseline" | "motivation" | "focus" | "misconception" | "constraints";

export type QuestionCandidate = {
  purpose: QuestionPurpose;
  text: string;
  thinkingHint: string;
};

export type TutorAnswerEvaluation = {
  intent: TutorTurnIntent;
  understoodMeaning: string;
  observations: Array<{ quote: string; implication: string }>;
  assessment: {
    status: "not-answered" | "insufficient" | "partial" | "misconception" | "mastered";
    score?: number;
    rubricEvidence: string[];
    evidence: LearningEvidence[];
  };
  misconceptionUpdates: MisconceptionUpdate[];
  pedagogy: {
    hit: string;
    unpunched: string;
    invented: string;
    sourceMove: string;
  };
  questionCandidates: QuestionCandidate[];
};

export type PedagogyMove = {
  hit: string;
  unpunched: string;
  invented: string;
  nextLayer: string;
  sourceMove: string;
  nextQuestion: string;
  questionPurpose: QuestionPurpose;
  restatedBiography: boolean;
};

export type NodeLearningState = {
  nodeId: string;
  stage: "introduce" | "elicit" | "repair" | "practice" | "transfer" | "doubt-check" | "mastered";
  evidence: LearningEvidence[];
  misconceptions: Array<{ description: string; status: "open" | "repaired"; evidenceQuote?: string }>;
  questionsAsked: string[];
  lastQuestionPurpose?: QuestionPurpose;
  hintLevel?: 0 | 1 | 2 | 3 | 4;
};

export type TopicModel = {
  id: string;
  topic: string;
  lessonTitle: string;
  coreOutcome: string;
  backgroundBrief: string;
  diagnosticDimensions: Array<{
    id: string;
    kind: DiagnosticKind;
    tab: string;
    rationale: string;
    teachingUse: string;
    question: string;
    thinkingHint: string;
    options: DiagnosticOption[];
  }>;
  conceptRoute: Array<{
    id: string;
    title: string;
    target: string;
    openingQuestion: string;
    openingHint: string;
    knowledgeTypes?: KnowledgeType[];
    requiredCapabilities?: string[];
  }>;
  boundaryCases: string[];
  practiceTarget: string;
  rubricAnchors: TopicRubricAnchor[];
  evidenceSources: string[];
  confidence: number;
  subject: {
    kind: string;
    description: string;
    userGoal: string;
  };
  grounding: {
    mode: string;
    sources: Array<{ label: string; verified: boolean }>;
    limitations: string[];
  };
  capabilities: LearningCapabilityPlan;
  subjectClassification?: SubjectClassification;
  domainPackIds?: DomainPackId[];
  domainCatalogVersion?: string;
};

export type TutorDiagnosis = {
  summary: string;
  learnerProfile: string[];
  evidence: Array<{ quote: string; implication: string }>;
  teachingApproach: {
    startingPoint: string;
    emphasis: string[];
    exampleContext: string;
    pacing: string;
    rationale: string[];
  };
  skipSuggestions?: Array<{
    conceptId: string;
    reason: string;
    confidence: "high" | "medium";
  }>;
};

export type TutorTurnDecision = {
  intent: TutorTurnIntent;
  understoodMeaning: string;
  evidence: Array<{ quote: string; implication: string }>;
  assessment: {
    status: "not-answered" | "insufficient" | "partial" | "misconception" | "mastered";
    score?: number;
    rubricEvidence: string[];
    evidence: LearningEvidence[];
  };
  misconceptionUpdates?: MisconceptionUpdate[];
  nextAction:
    | "explain"
    | "give-example"
    | "ask-clarification"
    | "repair-misconception"
    | "ask-socratic-question"
    | "give-practice"
    | "advance-concept"
    | "switch-topic"
    | "complete";
  statePatch: {
    activeConceptId?: string;
    addMisconception?: string;
    masteredConceptId?: string;
  };
  responsePlan: {
    goal: string;
    teachingAtom: string;
    gapToRepair: string;
    keyPoints: string[];
    allowedContent: string[];
    forbiddenContent: string[];
    backgroundBrief?: string;
    question?: string;
  };
  pedagogy?: PedagogyMove;
  thinking?: string;
};

export type UniversalTutorProfile = {
  id: "universal-mastery-tutor";
  version: string;
  diagnosticCardMin: 2;
  diagnosticCardMax: 6;
  evidenceLayers: string[];
  masteryThreshold: number;
  masteryCheckThreshold: number;
  questionPolicy: string;
};

export type DiagnosticOption = {
  id: string;
  label: string;
};

export type DiagnosticCard = {
  id: string;
  index: number;
  total: number;
  kind: DiagnosticKind;
  tab: string;
  rationale: string;
  teachingUse: string;
  question: string;
  thinkingHint: string;
  options: DiagnosticOption[];
};

export type RoadmapNode = {
  id: string;
  title: string;
  target: string;
  status: "active" | "locked" | "known" | "mastered";
};

export type VisibleReasoningTrace = {
  phase: TutorPhase;
  rawThinking: string;
  currentGoal?: string;
  inputsUsed?: string[];
  observedEvidence?: string[];
  candidateInterpretations?: Array<{
    interpretation: string;
    supportingEvidence: string[];
  }>;
  rejectedInterpretations?: Array<{
    interpretation: string;
    reason: string;
  }>;
  selectedInterpretation?: string;
  policyChecks?: string[];
  selectedAction?: string;
  actionReason?: string;
  stateUpdates?: string[];
  sourceCount?: number;
};

export type TutorState = {
  schemaVersion: 1 | 2 | 3 | 4 | 5;
  conversationId: string;
  learningSessionId: string;
  sessionStatus: LearningSessionStatus;
  phase: TutorPhase;
  topic?: string;
  lessonTitle?: string;
  topicModel?: TopicModel;
  universalProfileVersion?: string;
  diagnosticCards: DiagnosticCard[];
  diagnosticAnswers: Record<string, string>;
  currentCard: number;
  roadmap: RoadmapNode[];
  activeConcept: number;
  turnCount: number;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  learnerProfile: string[];
  teachingApproach?: TutorDiagnosis["teachingApproach"];
  knownIntuitions: Array<{ conceptId: string; reason: string; confidence: "high" | "medium" }>;
  nodeLearningStates: Record<string, NodeLearningState>;
  sessionMode?: "teach" | "explain";
  updatedAt: string;
  lastDecision?: TutorTurnDecision;
};

export type TutorEvent =
  | { type: "run.started"; runId: string; conversationId: string; learningSessionId?: string }
  | { type: "turn.intent.resolved"; resolution: TurnResolution }
  | { type: "learning.session.created"; learningSessionId: string; topic?: string }
  | { type: "learning.session.switched"; fromLearningSessionId: string; toLearningSessionId: string }
  | { type: "learning.session.paused"; learningSessionId: string }
  | { type: "learning.session.resumed"; learningSessionId: string }
  | { type: "tutor.phase.changed"; phase: TutorPhase; label: string }
  | { type: "research.completed"; sourceCount: number; researchedAt: string }
  | { type: "grounding.degraded"; reason: string }
  | { type: "model.degraded"; stage: "decision" | "response"; reason: string }
  | { type: "topic.model.ready"; title: string; outcome: string; topic: string }
  | { type: "subject.classification.resolved"; classification: SubjectClassification; domainPackIds: DomainPackId[]; domainCatalogVersion: string }
  | { type: "subject.classification.updated"; classification: SubjectClassification; domainPackIds: DomainPackId[]; domainCatalogVersion: string }
  | { type: "topic.background.ready"; summary: string }
  | { type: "diagnostic.cards.ready"; cards: DiagnosticCard[] }
  | { type: "diagnostic.card.ready"; card: DiagnosticCard }
  | { type: "diagnosis.ready"; diagnosis: string; background: string[]; teachingApproach: TutorDiagnosis["teachingApproach"] }
  | { type: "roadmap.ready"; roadmap: RoadmapNode[] }
  | { type: "reasoning.delta"; text: string }
  | { type: "reasoning.trace.ready"; trace: VisibleReasoningTrace }
  | { type: "assessment.updated"; score: number; status: "in-progress" | "mastered" }
  | { type: "state.saved"; phase: TutorPhase; activeConcept: number; learningSessionId?: string }
  | { type: "message.delta"; text: string }
  | { type: "run.completed"; runId: string }
  | { type: "run.failed"; runId: string; message: string };
