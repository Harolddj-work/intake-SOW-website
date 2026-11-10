const nodemailer = require('nodemailer');
const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

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
// SOW INTAKE SUBMISSION
// ==========================================

app.post('/api/submit-intake', async (req, res) => {

    try {

        const data = req.body;

        // 1. Validate required fields

        if (
            !data.fullName ||
            !data.email ||
            !data.companyName ||
            !data.projectName ||
            !data.businessProblem
        ) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields.'
            });
        }

        // 2. Format SOW intake information

        const ticketBody = `=== COMPREHENSIVE SOW INTAKE SUBMISSION ===

1. CONTACT & COMPANY
• Full Name: ${data.fullName}
• Email: ${data.email}
• Company: ${data.companyName}
• Key Stakeholders: ${data.stakeholders || 'N/A'}

2. OBJECTIVES & SCOPE
• Project Title: ${data.projectName}
• Business Problem / Objective: ${data.businessProblem}
• Current Process & Challenges: ${data.currentProcess || 'N/A'}
• Key Use Cases / Customer Journeys: ${data.useCases || 'N/A'}
• Success Metrics: ${data.successMetrics || 'N/A'}

3. FUNCTIONAL REQUIREMENTS
• Expected Functionalities: ${data.functionalities || 'N/A'}
• Intended Users & Volume: ${data.intendedUsers || 'N/A'}
• Required Channels: ${data.channels || 'N/A'}
• Automation & Workflows: ${data.automationWorkflow || 'N/A'}
• AI & Routing Needs: ${data.aiCapabilities || 'N/A'}

4. TECHNICAL & INTEGRATIONS
• Existing Platforms: ${data.existingPlatforms || 'N/A'}
• External Integrations & APIs: ${data.externalIntegrations || 'N/A'}
• Data Migration & Reporting: ${data.dataMigration || 'N/A'}
• Security & Compliance: ${data.securityCompliance || 'N/A'}

5. VOLUMES & SLAs
• Volumes & Peak Demand: ${data.volumes || 'N/A'}
• Operating Hours & Coverage: ${data.operatingHours || 'N/A'}
• Analytics & Reliability: ${data.analytics || 'N/A'}

6. TIMELINE, BUDGET & DELIVERABLES
• Target Start Date: ${data.startDate || 'N/A'}
• Go-Live Deadline: ${data.timeline || 'N/A'}
• Estimated Budget: ${data.budgetRange || 'N/A'}
• Expected Deliverables: ${data.deliverables || 'N/A'}
• Acceptance Criteria & Exclusions: ${data.exclusions || 'N/A'}`;

        // 3. Construct Zendesk ticket payload

        const zendeskData = {
            ticket: {
                subject: `[SOW Intake] - ${data.companyName} - ${data.projectName}`,

                requester: {
                    name: data.fullName,
                    email: data.email
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

        // 4. Get Zendesk OAuth access token

        const accessToken = await getZendeskAccessToken();

        // 5. Submit ticket to Zendesk

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

        const responseData = await zendeskResponse.json();

        // 6. Handle Zendesk errors

        if (!zendeskResponse.ok) {

            console.error('Zendesk Ticket Error:', responseData);

            return res.status(502).json({
                success: false,
                error: 'Failed to create Zendesk ticket.'
            });
        }
        // 7. Handle successful ticket creation

const ticket = responseData.ticket;

console.log(
    `Zendesk ticket created successfully: #${ticket.id}`
);

// 8. Send confirmation email

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

// 9. Return successful response

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

async function sendConfirmationEmail(data, ticketId) {

    const mailOptions = {
        from: process.env.EMAIL_FROM,

        to: data.email,

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
