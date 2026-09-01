# Universal Tutor

WalrySuperAgent turns an open-ended learning request into a durable, evidence-driven course without creating a different teacher for every subject.

## Language

**Learning Session**:
A durable course for one learning goal inside a Conversation. Its evidence and progress never leak into another Learning Session.
_Avoid_: Topic chat, course thread

**Subject Classification**:
A versioned, user-correctable description of the subject area a Learning Session belongs to. It selects defaults and constraints but never decides pedagogy or mastery by itself.
_Avoid_: Teacher type, agent type

**Macro Domain**:
One of nine broad subject labels used for navigation, defaults, and reporting. It is not the execution branch of the tutor.
_Avoid_: Agent category, tutor profile

**Knowledge Type**:
A node-level description of the kind of understanding or performance being learned, such as factual, causal, procedural, or formal knowledge.
_Avoid_: Subject, content format

**Domain Pack**:
A versioned bundle of domain constraints, capability requirements, safety flags, and assessment defaults. It enriches a Learning Model but does not own the teaching state machine.
_Avoid_: Domain teacher, domain agent

**Mastery Policy**:
The evidence criteria required to master one Learning Node, resolved from its Knowledge Types and Rubric.
_Avoid_: Model score, confidence score

**User Correction**:
An explicit learner-authored replacement for an inferred Subject Classification. It remains authoritative until the learner changes it again.
_Avoid_: Reclassification hint
