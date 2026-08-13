export type TutorPhase =
  | "idle"
  | "research"
  | "diagnose"
  | "plan"
  | "teach"
  | "complete";

export type TutorTurnIntent =
  | "answer"
  | "dont_know"
  | "disagreement"
  | "clarification"
  | "direct_answer_request"
  | "topic_switch"
  | "meta_question"
  | "stop";

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

export type LearningEvidence = {
  learnerQuote: string;
  criterion: "accurate" | "explained" | "discrimination" | "transfer" | "performance";
  strength: "weak" | "sufficient";
};

export type PedagogyMove = {
  hit: string;
  unpunched: string;
  invented: string;
  nextLayer: string;
  sourceMove: string;
  nextQuestion: string;
  questionPurpose: "accurate" | "explained" | "discrimination" | "transfer" | "performance" | "introduce";
  restatedBiography: boolean;
};

export type NodeLearningState = {
  nodeId: string;
  stage: "introduce" | "elicit" | "repair" | "practice" | "transfer" | "doubt-check" | "mastered";
  evidence: LearningEvidence[];
  misconceptions: Array<{ description: string; status: "open" | "repaired" }>;
  questionsAsked: string[];
};

export type TopicModel = {
  id: string;
  topic: string;
  lessonTitle: string;
  coreOutcome: string;
  diagnosticDimensions: Array<{
    id: string;
    tab: string;
    question: string;
    options: DiagnosticOption[];
  }>;
  conceptRoute: Array<{
    id: string;
    title: string;
    target: string;
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
};

export type TutorDiagnosis = {
  summary: string;
  learnerProfile: string[];
  evidence: Array<{ quote: string; implication: string }>;
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
  tab: string;
  question: string;
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
  schemaVersion: 1 | 2 | 3 | 4;
  conversationId: string;
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
  knownIntuitions: Array<{ conceptId: string; reason: string; confidence: "high" | "medium" }>;
  nodeLearningStates: Record<string, NodeLearningState>;
  updatedAt: string;
  lastDecision?: TutorTurnDecision;
};

export type TutorEvent =
  | { type: "run.started"; runId: string; conversationId: string }
  | { type: "tutor.phase.changed"; phase: TutorPhase; label: string }
  | { type: "research.completed"; sourceCount: number; researchedAt: string }
  | { type: "grounding.degraded"; reason: string }
  | { type: "model.degraded"; stage: "decision" | "response"; reason: string }
  | { type: "topic.model.ready"; title: string; outcome: string; topic: string }
  | { type: "diagnostic.cards.ready"; cards: DiagnosticCard[] }
  | { type: "diagnostic.card.ready"; card: DiagnosticCard }
  | { type: "diagnosis.ready"; diagnosis: string; background: string[] }
  | { type: "roadmap.ready"; roadmap: RoadmapNode[] }
  | { type: "reasoning.delta"; text: string }
  | { type: "reasoning.trace.ready"; trace: VisibleReasoningTrace }
  | { type: "assessment.updated"; score: number; status: "in-progress" | "mastered" }
  | { type: "state.saved"; phase: TutorPhase; activeConcept: number }
  | { type: "message.delta"; text: string }
  | { type: "run.completed"; runId: string }
  | { type: "run.failed"; runId: string; message: string };
