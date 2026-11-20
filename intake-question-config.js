// Six fixed checkpoints. These are information requirements, NOT fixed questions.
// The AI creates each question from the project context and answers collected so far.
const checkpoints = [
  { id: 'contact', title: 'Contact & Company', items: [
    { id: 'contact_person', label: 'Contact person', guidance: 'Name and role of the primary client contact.' },
    { id: 'contact_email', label: 'Contact email', guidance: 'A valid business email for the primary contact.' },
    { id: 'company', label: 'Company', guidance: 'Company or organization name and relevant business context.' },
    { id: 'stakeholders', label: 'Key stakeholders', guidance: 'Decision makers, business owners, users, approvers, and technical contacts.' }
  ]},
  { id: 'objectives', title: 'Business Objectives', items: [
    { id: 'problem', label: 'Problem or opportunity', guidance: 'The business problem, opportunity, and why action is needed.' },
    { id: 'current_process', label: 'Current process', guidance: 'How the work is done today, including tools, teams, and important steps.' },
    { id: 'pain_points', label: 'Pain points', guidance: 'Specific issues, bottlenecks, costs, risks, or customer impacts.' },
    { id: 'use_cases', label: 'Use cases', guidance: 'Concrete scenarios and journeys the proposed solution should support.' },
    { id: 'success_criteria', label: 'Measurable success criteria', guidance: 'Outcomes, KPIs, baseline and target values where known.' }
  ]},
  { id: 'functional', title: 'Functional Requirements', items: [
    { id: 'capabilities', label: 'Required capabilities', guidance: 'Features, tasks, inputs, outputs, and expected system behavior.' },
    { id: 'users', label: 'Users and user types', guidance: 'Who will use the solution, roles, and estimated number of users.' },
    { id: 'channels', label: 'Channels', guidance: 'Communication or interaction channels in scope, where relevant.' },
    { id: 'automation', label: 'Automation and human approval', guidance: 'What is automated, what needs human approval, handoffs and exceptions.' },
    { id: 'ai_routing', label: 'AI and routing needs', guidance: 'AI use cases, routing rules, escalation, confidence thresholds, human handoff, if relevant.' }
  ]},
  { id: 'technical', title: 'Technical & Integration', items: [
    { id: 'systems', label: 'Existing systems', guidance: 'Systems to retain, replace, connect to, or avoid.' },
    { id: 'integrations', label: 'Integrations and data exchange', guidance: 'Systems, APIs, data exchanged, direction, frequency, and ownership.' },
    { id: 'migration', label: 'Data migration', guidance: 'Data to migrate, source, volume, quality, history and migration responsibility.' },
    { id: 'security', label: 'Security and compliance', guidance: 'Access controls, privacy, data residency, regulatory and industry requirements.' }
  ]},
  { id: 'volumes', title: 'Volumes & SLAs', items: [
    { id: 'volume', label: 'Volumes and peak periods', guidance: 'Expected transactions, interactions, records, concurrency and peak demand.' },
    { id: 'hours', label: 'Operating hours and coverage', guidance: 'Hours, time zones, locations, languages and support coverage.' },
    { id: 'reporting', label: 'Reporting and analytics', guidance: 'Dashboards, reports, metrics, recipients and reporting frequency.' },
    { id: 'availability', label: 'Availability and performance', guidance: 'Uptime, response times, recovery, service levels and reliability expectations.' }
  ]},
  { id: 'delivery', title: 'Timeline, Budget & Deliverables', items: [
    { id: 'start_date', label: 'Target start date', guidance: 'Desired project start date and any preparation dependencies.' },
    { id: 'go_live', label: 'Go-live target', guidance: 'Target launch date, milestones and deadline flexibility.' },
    { id: 'budget', label: 'Budget', guidance: 'Budget range, funding status, cost constraints or approval status.' },
    { id: 'deliverables', label: 'Deliverables', guidance: 'Expected solution components, configuration, integrations, training, documentation and handover.' },
    { id: 'acceptance', label: 'Acceptance criteria', guidance: 'Testing, sign-off owner, measurable acceptance conditions and exclusions.' }
  ]}
];

module.exports = { checkpoints, MAX_FOLLOW_UPS_PER_ITEM: 2 };
