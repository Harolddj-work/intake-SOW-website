const nodemailer = require('nodemailer');
const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

// ==========================================
// AI EVALUATION CONFIGURATION
// ==========================================

const intakeQuestions = require('./intake-question-config');

const {
    evaluateAnswer,
    evaluateAnswers,
    EVALUATION_QUESTION_IDS
} = require('./ai-evaluator');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// ZENDESK OAUTH CONFIGURATION
// ==========================================

let zendeskAccessToken = null;
let zendeskTokenExpiresAt = 0;

async function getZendeskAccessToken() {

    if (
        zendeskAccessToken &&
        Date.now() < zendeskTokenExpiresAt - 60000
    ) {
        return zendeskAccessToken;
    }

    const response = await fetch(
        `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/oauth/tokens`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: process.env.ZENDESK_CLIENT_ID,
                client_secret: process.env.ZENDESK_CLIENT_SECRET,
                scope: 'tickets:write'
            })
        }
    );

    const tokenData = await response.json();

    if (!response.ok) {
        console.error('Zendesk OAuth Error:', tokenData);
        throw new Error('Zendesk authentication failed.');
    }

    zendeskAccessToken = tokenData.access_token;

    zendeskTokenExpiresAt =
        Date.now() + (tokenData.expires_in * 1000);

    console.log('Zendesk OAuth authentication successful.');

    return zendeskAccessToken;
}

// ==========================================
// EMAIL CONFIGURATION
// ==========================================

const emailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === 'true',

    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});


// ==========================================
// AI ANSWER EVALUATION
// ==========================================

app.post('/api/evaluate-answer', async (req, res) => {

    try {

        // 1. Retrieve information from the frontend
        const { questionId, answer } = req.body;

        // 2. Validate the incoming request
        if (
            typeof questionId !== 'string' ||
            !questionId.trim() ||
            typeof answer !== 'string'
        ) {
            return res.status(400).json({
                success: false,
                error: 'Invalid question ID or answer.'
            });
        }

        // 3. Find the corresponding question configuration
        const questionConfig = intakeQuestions[questionId];

        if (!questionConfig) {
            return res.status(404).json({
                success: false,
                error: 'Question configuration not found.'
            });
        }

        // 4. Evaluate the client's answer
        const evaluation = await evaluateAnswer({
            questionConfig,
            answer
        });

        // 5. Return the evaluation to the frontend
        return res.status(200).json({
            success: true,
            questionId,
            evaluation
        });

    } catch (error) {

        console.error('AI Evaluation Error:', error);

        return res.status(500).json({
            success: false,
            error: 'Unable to evaluate answer.'
        });

    }

});

// ==========================================
// BATCH AI ANSWER EVALUATION
// ==========================================

app.post('/api/evaluate-answers', async (req, res) => {
    try {
        const { answers, questionIds, evidenceQuestionIds } = req.body;

        if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid answers payload.'
            });
        }

        const evaluations = await evaluateAnswers({
            answers,
            questionIds,
            evidenceQuestionIds
        });

        return res.status(200).json({
            success: true,
            evaluations
        });

    } catch (error) {
        console.error('Batch AI Evaluation Error:', error);

        return res.status(500).json({
            success: false,
            error: 'Unable to evaluate intake answers.'
        });
    }
});

// ==========================================
// SOW INTAKE SUBMISSION
// ==========================================

app.post('/api/submit-intake', async (req, res) => {

    try {

        const data = req.body;

        // Validate the request on the server as well as in the browser.
        // Client-side validation can be bypassed, so never send malformed
        // intake data to Zendesk.

        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid intake submission payload.'
            });
        }

        const requiredFields = {
            fullName: 'Full Name',
            email: 'Business Email',
            companyName: 'Company / Organization Name',
            stakeholders: 'Key Stakeholders & Technical Contacts',
            projectName: 'Project Name / Working Title',
            intendedUsers: 'Intended Users & Estimated User Count',
            channels: 'Required Communication Channels',
            aiCapabilities: 'AI Capabilities / Routing Needs',
            existingPlatforms: 'Existing Platforms',
            externalIntegrations: 'External Integrations',
            dataMigration: 'Data Migration / Reporting',
            securityCompliance: 'Security / Compliance',
            volumes: 'Volumes & Peak Demand',
            operatingHours: 'Operating Hours & Coverage',
            analytics: 'Analytics / Reliability Requirements',
            startDate: 'Target Start Date',
            timeline: 'Go-Live Deadline',
            budgetRange: 'Estimated Budget'
        };

        const missingFields = Object.entries(requiredFields)
            .filter(([field]) =>
                typeof data[field] !== 'string' ||
                !data[field].trim()
            )
            .map(([, label]) => label);

        if (missingFields.length) {
            return res.status(400).json({
                success: false,
                error: `Please complete these required fields: ${missingFields.join(', ')}.`
            });
        }

        // ==========================================
        // EMAIL VALIDATION
        // ==========================================

        const email = data.email.trim();

        const emailPattern =
            /^[A-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+[A-Z]{2,}$/i;

        if (email.length > 254 || !emailPattern.test(email)) {
            return res.status(400).json({
                success: false,
                error: 'Please enter a valid email address, such as name@example.com.'
            });
        }

        // ==========================================
        // FULL NAME VALIDATION
        // ==========================================

        const fullName = data.fullName.trim();

        if (
            fullName.length > 100 ||
            !/^[\p{L}][\p{L}\p{M} .'-]{0,99}$/u.test(fullName)
        ) {
            return res.status(400).json({
                success: false,
                error: 'Please enter a valid full name using letters, spaces, apostrophes, periods, or hyphens.'
            });
        }

        // ==========================================
        // FIELD LENGTH VALIDATION
        // ==========================================

        const maxLengths = {
            companyName: 150,
            stakeholders: 500,
            projectName: 150,
            intendedUsers: 150,
            channels: 200,
            aiCapabilities: 500,
            existingPlatforms: 500,
            externalIntegrations: 500,
            dataMigration: 500,
            securityCompliance: 500,
            volumes: 500,
            operatingHours: 500,
            analytics: 500,
            timeline: 120
        };

        for (const [field, maxLength] of Object.entries(maxLengths)) {

            if (data[field].trim().length > maxLength) {
                return res.status(400).json({
                    success: false,
                    error: `${requiredFields[field] || field} must be ${maxLength} characters or fewer.`
                });
            }

        }

        // ==========================================
        // INTENDED USERS VALIDATION
        // ==========================================

        if (!/\d/.test(data.intendedUsers)) {
            return res.status(400).json({
                success: false,
                error: 'Please include an estimated user count, for example: 50 support agents.'
            });
        }

        // ==========================================
        // DATE VALIDATION
        // ==========================================

        // Accept only a real YYYY-MM-DD calendar date.

        const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data.startDate);

        if (!dateMatch) {
            return res.status(400).json({
                success: false,
                error: 'Please provide the target start date in YYYY-MM-DD format.'
            });
        }

        const parsedDate = new Date(
            Date.UTC(
                Number(dateMatch[1]),
                Number(dateMatch[2]) - 1,
                Number(dateMatch[3])
            )
        );

        if (
            parsedDate.getUTCFullYear() !== Number(dateMatch[1]) ||
            parsedDate.getUTCMonth() !== Number(dateMatch[2]) - 1 ||
            parsedDate.getUTCDate() !== Number(dateMatch[3])
        ) {
            return res.status(400).json({
                success: false,
                error: 'Please provide a valid calendar date for the target start date.'
            });
        }
        // ==========================================
        // MINIMUM 7-DAY START DATE VALIDATION
        // ==========================================

        // Get today's date in Philippine time (Asia/Manila)
        const manilaToday = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Manila',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).format(new Date());

        const [todayYear, todayMonth, todayDay] =
            manilaToday.split('-').map(Number);

        const todayUtc = Date.UTC(
            todayYear,
            todayMonth - 1,
            todayDay
        );

        // Minimum start date is 7 days from today
        const minimumStartUtc =
            todayUtc + (7 * 24 * 60 * 60 * 1000);

        // Convert submitted start date to UTC
        const submittedStartUtc = Date.UTC(
            Number(dateMatch[1]),
            Number(dateMatch[2]) - 1,
            Number(dateMatch[3])
        );

        // Reject dates earlier than the minimum
        if (submittedStartUtc < minimumStartUtc) {

            const minimumDate = new Date(minimumStartUtc)
                .toISOString()
                .slice(0, 10);

            return res.status(400).json({
                success: false,
                error: `Target Start Date must be at least 7 days from today. Earliest allowed date: ${minimumDate}.`
            });
        }
        // ==========================================
        // BUDGET VALIDATION
        // ==========================================

        const allowedBudgets = new Set([
            '<$10k',
            '$10k-$25k',
            '$25k-$50k',
            '$50k+'
        ]);

        if (!allowedBudgets.has(data.budgetRange)) {
            return res.status(400).json({
                success: false,
                error: 'Please select one of the available estimated budget ranges.'
            });
        }

        // ==========================================
        // NARRATIVE FIELD VALIDATION
        // ==========================================

        // Prevent unexpectedly large free-text payloads while keeping
        // narrative responses flexible enough for detailed project context.

        const narrativeFields = [
            'businessProblem',
            'currentProcess',
            'useCases',
            'successMetrics',
            'functionalities',
            'automationWorkflow',
            'deliverables',
            'exclusions'
        ];

        for (const field of narrativeFields) {

            if (
                data[field] !== undefined &&
                (
                    typeof data[field] !== 'string' ||
                    data[field].length > 5000
                )
            ) {
                return res.status(400).json({
                    success: false,
                    error: `The ${field} response must be text and 5,000 characters or fewer.`
                });
            }

        }

        // ==========================================
        // TICKET QUESTION FORMATTING
        // ==========================================

        // Format each reviewed narrative answer together with its own
        // clarification Q&A. This keeps the ticket readable and removes
        // the separate, repetitive AI evaluation history section.


        // Format reviewed answers with clear numbering, separated Q&A,
        // and an explicit project-team review flag.
        function formatQuestionBlock(questionId, label, itemNumber, fallback = 'N/A') {
            const submittedAnswer = data[questionId];

            const originalAnswer =
                typeof submittedAnswer === 'string' && submittedAnswer.trim()
                    ? submittedAnswer.trim()
                    : fallback;

            const review = data.aiEvaluation?.[questionId] || {};

            const clarificationQuestion =
                typeof review.clarificationQuestion === 'string'
                    ? review.clarificationQuestion.trim()
                    : '';

            const clarificationAnswer =
                typeof review.clarificationAnswer === 'string'
                    ? review.clarificationAnswer.trim()
                    : '';

            const needsManualReview =
                review.needsManualReview === true ||
                review.evaluation?.status === 'needs_review' ||
                (
                    review.evaluation?.sufficient === false &&
                    Boolean(clarificationAnswer)
                );

            const lines = [
                `${itemNumber}. ${label.toUpperCase()}`,
                '',
                '   CLIENT ANSWER',
                `   ${originalAnswer}`
            ];

            if (clarificationQuestion || clarificationAnswer) {
                lines.push(
                    '',
                    '   CLARIFICATION',
                    `   Follow-up question: ${clarificationQuestion || 'Not recorded'}`,
                    `   Client clarification: ${clarificationAnswer || 'Not provided'}`
                );
            }

            if (needsManualReview) {
                lines.push(
                    '',
                    '   !!! NEEDS PROJECT TEAM REVIEW !!!',
                    '   The submitted clarification may not fully address the requested information. Please review during SOW discovery.'
                );
            }

            return lines.join('\n');
        }

        function formatSectionHeader(number, title) {
            return `\n========================================\n${number}. ${title.toUpperCase()}\n========================================`;
        }

        const ticketBody = `COMPREHENSIVE SOW INTAKE SUBMISSION

${formatSectionHeader('01', 'Contact & Company')}

• Full Name: ${data.fullName}
• Email: ${data.email}
• Company: ${data.companyName}
• Key Stakeholders: ${data.stakeholders || 'N/A'}

${formatSectionHeader('02', 'Objectives & Scope')}

${formatQuestionBlock('businessProblem', 'Business Problem / Objective', '2.1', 'Not separately provided; see related responses below if applicable.')}

${formatQuestionBlock('currentProcess', 'Current Process & Challenges', '2.2')}

${formatQuestionBlock('useCases', 'Key Use Cases / Customer Journeys', '2.3')}

${formatQuestionBlock('successMetrics', 'Success Metrics', '2.4')}

${formatSectionHeader('03', 'Functional Requirements')}

${formatQuestionBlock('functionalities', 'Expected Functionalities', '3.1')}

• Intended Users & Volume: ${data.intendedUsers || 'N/A'}
• Required Channels: ${data.channels || 'N/A'}

${formatQuestionBlock('automationWorkflow', 'Automation & Workflows', '3.2')}

• AI & Routing Needs: ${data.aiCapabilities || 'N/A'}

${formatSectionHeader('04', 'Technical & Integrations')}

• Existing Platforms: ${data.existingPlatforms || 'N/A'}
• External Integrations & APIs: ${data.externalIntegrations || 'N/A'}
• Data Migration & Reporting: ${data.dataMigration || 'N/A'}
• Security & Compliance: ${data.securityCompliance || 'N/A'}

${formatSectionHeader('05', 'Volumes & SLAs')}

• Volumes & Peak Demand: ${data.volumes || 'N/A'}
• Operating Hours & Coverage: ${data.operatingHours || 'N/A'}
• Analytics & Reliability: ${data.analytics || 'N/A'}

${formatSectionHeader('06', 'Timeline, Budget & Deliverables')}

• Target Start Date: ${data.startDate || 'N/A'}
• Go-Live Deadline: ${data.timeline || 'N/A'}
• Estimated Budget: ${data.budgetRange || 'N/A'}

${formatQuestionBlock('deliverables', 'Expected Deliverables', '6.1')}

${formatQuestionBlock('exclusions', 'Acceptance Criteria & Exclusions', '6.2')}

========================================
END OF INTAKE SUBMISSION
========================================`;

        // ==========================================
        // CONSTRUCT ZENDESK TICKET PAYLOAD
        // ==========================================

        const zendeskData = {
            ticket: {
                subject: `[SOW Intake] - ${data.companyName} - ${data.projectName}`,

                requester: {
                    name: data.fullName,
                    email: data.email.trim()
                },

                comment: {
                    body: ticketBody,
                    public: false
                },

                status: 'new',

                tags: [
                    'sow_intake',
                    'presale_lead',
                    'pending_ai_sow'
                ]
            }
        };

        // ==========================================
        // GET ZENDESK OAUTH ACCESS TOKEN
        // ==========================================

        const accessToken = await getZendeskAccessToken();

        // ==========================================
        // SUBMIT TICKET TO ZENDESK
        // ==========================================

        const zendeskResponse = await fetch(
            `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets.json`,
            {
                method: 'POST',

                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken}`
                },

                body: JSON.stringify(zendeskData)
            }
        );

        const responseData = await zendeskResponse
            .json()
            .catch(() => null);

        // ==========================================
        // HANDLE ZENDESK ERRORS
        // ==========================================

        // Keep provider details in server logs, but return a stable,
        // actionable message to the browser.

        if (
            !zendeskResponse.ok ||
            !responseData?.ticket?.id
        ) {

            console.error(
                'Zendesk Ticket Error:',
                responseData || 'Zendesk returned an unreadable response.'
            );

            return res.status(502).json({
                success: false,
                error: 'Zendesk could not create the ticket. Please verify the Zendesk integration configuration and try again.'
            });

        }

        // ==========================================
        // HANDLE SUCCESSFUL TICKET CREATION
        // ==========================================

        const ticket = responseData.ticket;

        console.log(
            `Zendesk ticket created successfully: #${ticket.id}`
        );

        // ==========================================
        // SEND CONFIRMATION EMAIL
        // ==========================================

        let emailSent = false;

        try {

            await sendConfirmationEmail(data, ticket.id);

            emailSent = true;

        } catch (emailError) {

            console.error(
                'Confirmation Email Error:',
                emailError
            );

        }

        // ==========================================
        // RETURN SUCCESSFUL RESPONSE
        // ==========================================

        return res.status(201).json({
            success: true,

            message: 'SOW intake successfully submitted to Zendesk!',

            ticketId: ticket.id,
            ticketSubject: ticket.subject,
            ticketStatus: ticket.status,

            confirmationEmailSent: emailSent,

            zendeskUrl:
                `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/agent/tickets/${ticket.id}`
        });

    } catch (error) {

        console.error('Server Error:', error);

        return res.status(500).json({
            success: false,
            error: 'Internal server error.'
        });

    }

});

// ==========================================
// CONFIRMATION EMAIL FUNCTION
// ==========================================

async function sendConfirmationEmail(data, ticketId) {

    const mailOptions = {

        from: process.env.EMAIL_FROM,

        to: data.email.trim(),

        subject: `SOW Intake Received - ${data.projectName}`,

        text: `
Hello ${data.fullName},

Thank you for submitting your Statement of Work (SOW) intake form.

We have successfully received your submission and created a support ticket in our system.

SUBMISSION DETAILS

Company: ${data.companyName}
Project: ${data.projectName}
Reference Ticket ID: #${ticketId}

WHAT HAPPENS NEXT?

The TPS Team is currently reviewing the information and requirements provided in your submission and is working on the preparation of a Proof of Concept (POC) tailored to your business needs and project objectives.

Our team will keep you informed of the progress and coordinate with you regarding the next steps.

Thank you for your patience and for considering our team for your project.

Best regards,
TPS Team

This is an automated confirmation email. Please do not reply directly to this message.
        `.trim()

    };

    const info = await emailTransporter.sendMail(mailOptions);

    console.log(
        `Confirmation email successfully sent to ${data.email}: ${info.messageId}`
    );

    return info;
}


// ==========================================
// START SERVER
// ==========================================

app.listen(PORT, () => {

    console.log(
        `SOW Intake Server running at http://localhost:${PORT}`
    );

});