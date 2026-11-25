// Six fixed checkpoints. These are information requirements, NOT fixed questions.
// The AI creates each question from the project context and answers collected so far.
const checkpoints = [
  { id: 'contact', title: 'Contact & Company', items: [
    { id: 'contact_person', label: 'Contact person', guidance: 'Name and role of the primary client contact.' },
    { id: 'contact_email', label: 'Contact email', guidance: 'A valid business email for the primary contact.' },
    { id: 'company', label: 'Company', guidance: 'Company or organization name and relevant business context.' },
    { id: 'stakeholders', label: 'Key stakeholders and project contacts', guidance: 'Capture each additional stakeholder and person managing or coordinating the project individually: full name, role/title, responsibility in the project, and a valid email address. Include decision makers, business owners, users, approvers, technical contacts, project manager and day-to-day coordinator. If an email is not yet known, explicitly mark it as pending and identify who will provide it.' }
  ]},
  { id: 'objectives', title: 'Business Objectives', items: [
    { id: 'problem', label: 'Problem or opportunity', guidance: 'The business problem, opportunity, why action is needed, who is affected, current impact and concrete examples or evidence.' },
    { id: 'current_process', label: 'Current process', guidance: 'How the work is done today, including each team/role, systems used, sequence of steps, handoffs, volumes and exceptions.' },
    { id: 'pain_points', label: 'Pain points', guidance: 'Specific issues, where they occur, frequency, volume, business/customer impact, root causes and examples.' },
    { id: 'use_cases', label: 'Use cases', guidance: 'Concrete end-to-end scenarios: trigger, user, steps, inputs, expected output, exceptions and desired outcome.' },
    { id: 'success_criteria', label: 'Measurable success criteria', guidance: 'Measurable outcomes with KPI definitions, current baseline, target, measurement method, reporting owner and target timeframe.' }
  ]},
  { id: 'functional', title: 'Functional Requirements', items: [
    { id: 'capabilities', label: 'Required capabilities', guidance: 'Specific features and user tasks, inputs, business rules, outputs, validations, error/exception handling and acceptance behavior.' },
    { id: 'users', label: 'Users and user types', guidance: 'Who will use the solution, roles, and estimated number of users.' },
    { id: 'channels', label: 'Channels', guidance: 'Communication or interaction channels in scope, where relevant.' },
    { id: 'automation', label: 'Automation and human approval', guidance: 'What is automated, what needs human approval, handoffs and exceptions.' },
    { id: 'ai_routing', label: 'AI and routing needs', guidance: 'AI use cases, routing rules, escalation, confidence thresholds, human handoff, if relevant.' }
  ]},
  { id: 'technical', title: 'Technical & Integration', items: [
    { id: 'systems', label: 'Existing systems', guidance: 'Systems to retain, replace, connect to, or avoid.' },
    { id: 'integrations', label: 'Integrations and data exchange', guidance: 'For each integration: system/vendor, purpose, data fields/types, source and destination, direction, API/method, frequency/trigger, authentication, owner and error handling.' },
    { id: 'migration', label: 'Data migration', guidance: 'Data to migrate, source, volume, quality, history and migration responsibility.' },
    { id: 'tech_stack_preference', label: 'Preferred technology stack', guidance: 'Whether the client requires specific technologies, platforms, cloud providers, programming languages, databases, vendors or standards, or whether the delivery team is free to recommend the best-fit stack. Capture constraints and decision owner.' },
    { id: 'security', label: 'Security and compliance', guidance: 'Access controls, privacy, data residency, regulatory and industry requirements.' }
  ]},
  { id: 'volumes', title: 'Volumes & SLAs', items: [
    { id: 'volume', label: 'Volumes and peak periods', guidance: 'Quantified average and peak volumes, units/time period, concurrency, seasonality, growth assumptions and source of estimate.' },
    { id: 'hours', label: 'Operating hours and coverage', guidance: 'Hours, time zones, locations, languages and support coverage.' },
    { id: 'reporting', label: 'Reporting and analytics', guidance: 'Dashboards, reports, metrics, recipients and reporting frequency.' },
    { id: 'availability', label: 'Availability and performance', guidance: 'Uptime, response times, recovery, service levels and reliability expectations.' }
  ]},
  { id: 'delivery', title: 'Timeline, Budget & Deliverables', items: [
    { id: 'start_date', label: 'Project start date', guidance: 'Capture the planned project start date (not the discovery interview date). Accept either a specific calendar date or month and year. The project must start at least 14 calendar days after this intake form is created; there is no maximum lead time. Also capture preparation time, prerequisites, client-side dependencies, access, approvals and named owners. If only month/year is known, record that precision and do not invent a day.' },
    { id: 'go_live', label: 'Project go-live date', guidance: 'Capture the planned project go-live date as a specific calendar date or month and year. Go-live must be at least 2 calendar months after the project start date supplied by the client; there is no maximum lead time. Capture key milestones, launch dependencies, deadline flexibility and whether the target is fixed or preferred. Do not accept a go-live target earlier than this minimum.' },
    { id: 'budget', label: 'Budget', guidance: 'Budget range, funding status, cost constraints or approval status.' },
    { id: 'deliverables', label: 'Deliverables', guidance: 'Expected solution components, configuration, integrations, training, documentation and handover.' },
    { id: 'acceptance', label: 'Acceptance criteria', guidance: 'Test scenarios, measurable pass/fail criteria, UAT owner, approver/sign-off process, evidence required, exclusions and defect handling.' }
  ]}
];

const requiredForStart = [
  'stakeholders', 'problem', 'use_cases', 'success_criteria',
  'capabilities', 'users', 'systems', 'integrations', 'security',
  'start_date', 'go_live', 'deliverables', 'acceptance'
];

module.exports = { checkpoints, requiredForStart, MAX_FOLLOW_UPS_PER_ITEM: 3 };
