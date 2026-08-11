export type TutorPhase =
  | "idle"
  | "research"
  | "diagnose"
  | "plan"
  | "teach"
  | "complete";

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
  currentGoal: string;
  inputsUsed: string[];
  observedEvidence: string[];
  candidateInterpretations: Array<{
    interpretation: string;
    supportingEvidence: string[];
  }>;
  rejectedInterpretations: Array<{
    interpretation: string;
    reason: string;
  }>;
  selectedInterpretation: string;
  policyChecks: string[];
  selectedAction: string;
  actionReason: string;
  stateUpdates: string[];
  sourceCount?: number;
};

export type TutorState = {
  schemaVersion: 1;
  conversationId: string;
  phase: TutorPhase;
  topic?: string;
  lessonTitle?: string;
  diagnosticCards: DiagnosticCard[];
  diagnosticAnswers: Record<string, string>;
  currentCard: number;
  roadmap: RoadmapNode[];
  activeConcept: number;
  turnCount: number;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  updatedAt: string;
};

export type TutorEvent =
  | { type: "run.started"; runId: string; conversationId: string }
  | { type: "tutor.phase.changed"; phase: TutorPhase; label: string }
  | { type: "research.completed"; sourceCount: number; researchedAt: string }
  | { type: "lesson.model.ready"; title: string; outcome: string }
  | { type: "diagnostic.card.ready"; card: DiagnosticCard }
  | { type: "diagnosis.ready"; diagnosis: string; background: string[] }
  | { type: "roadmap.ready"; roadmap: RoadmapNode[] }
  | { type: "reasoning.trace.ready"; trace: VisibleReasoningTrace }
  | { type: "assessment.updated"; score: number; status: "in-progress" | "mastered" }
  | { type: "state.saved"; phase: TutorPhase; activeConcept: number }
  | { type: "message.delta"; text: string }
  | { type: "run.completed"; runId: string }
  | { type: "run.failed"; runId: string; message: string };
