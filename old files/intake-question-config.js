const intakeQuestions = {
    businessProblem: {
        label: 'Business Problem / Objective',
        step: 2,
        aiEvaluate: true,
        question: 'What is the primary business problem or objective you want to address?',
        requiredEvidence: [
            'The business problem or opportunity being addressed.',
            'The process, people, or operations affected.',
            'The intended business outcome or objective.'
        ],
        critical: true
    },

    currentProcess: {
        label: 'Current Process & Challenges',
        step: 2,
        aiEvaluate: true,
        question: 'What is your current process, and what challenges or limitations are you experiencing?',
        requiredEvidence: [
            'Description of the existing process and its important steps.',
            'Specific challenges, bottlenecks, or limitations.',
            'People, teams, or operations affected.'
        ],
        critical: true
    },

    useCases: {
        label: 'Use Cases / Customer Journeys',
        step: 2,
        aiEvaluate: true,
        question: 'What specific business processes, customer journeys, or use cases do you want to implement or improve?',
        requiredEvidence: [
            'Specific processes, customer journeys, or scenarios.',
            'What users need to do in each important scenario.',
            'The desired improvement or outcome for those scenarios.'
        ],
        critical: true
    },

    successMetrics: {
        label: 'Success Metrics',
        step: 2,
        aiEvaluate: true,
        question: 'What are your expected business outcomes, and how will you measure project success?',
        requiredEvidence: [
            'Expected business outcomes.',
            'Measurable success criteria, targets, or KPIs where available.',
            'How or when project success will be assessed.'
        ],
        critical: true
    },

    functionalities: {
        label: 'Expected Functionalities',
        step: 3,
        aiEvaluate: true,
        question: 'What specific functionalities or capabilities do you expect from the proposed solution?',
        requiredEvidence: [
            'The main capabilities or features the solution must provide.',
            'What users or the system should be able to do with those capabilities.',
            'Important expected behavior, outputs, or functional boundaries.'
        ],
        critical: true
    },

    automationWorkflow: {
        label: 'Automation & Human Workflow',
        step: 3,
        aiEvaluate: true,
        question: 'Automation vs. Human Intervention: Which processes should be automated and which require human approval?',
        requiredEvidence: [
            'The processes or tasks intended to be automated.',
            'The tasks or decisions that require human review, approval, or intervention.',
            'Important triggers, decision points, handoffs, or exception paths.'
        ],
        critical: true
    },

    deliverables: {
        label: 'Expected Deliverables',
        step: 6,
        aiEvaluate: true,
        question: 'What deliverables do you expect (configuration, integration, training, etc.)?',
        requiredEvidence: [
            'The concrete outputs, components, or services expected from the project.',
            'The important scope or contents of those deliverables.',
            'Any relevant delivery format, documentation, training, or handover expectations.'
        ],
        critical: true
    },

    exclusions: {
        label: 'Acceptance Criteria & Exclusions',
        step: 6,
        aiEvaluate: true,
        question: 'What are your acceptance criteria, testing expectations, and explicit exclusions?',
        requiredEvidence: [
            'How the client will determine that the solution or deliverables are acceptable.',
            'Important testing, validation, or sign-off expectations.',
            'Items, features, or responsibilities that are explicitly out of scope, or a clear statement that no exclusions are currently known.'
        ],
        critical: true
    }
};

module.exports = intakeQuestions;
