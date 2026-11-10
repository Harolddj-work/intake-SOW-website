const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/submit-intake', async (req, res) => {
    try {
        const data = req.body;

        if (!data.fullName || !data.email || !data.companyName || !data.projectName || !data.businessProblem) {
            return res.status(400).json({ error: 'Missing required fields.' });
        }

        // Format all expanded questions into structured markdown for Zendesk & Sir Kevs' AI SOW Maker
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

        const zendeskData = {
            ticket: {
                subject: `[SOW Intake] - ${data.companyName} - ${data.projectName}`,
                requester: {
                    name: data.fullName,
                    email: data.email
                },
                comment: {
                    body: ticketBody
                },
                tags: ["sow_intake", "presale_lead", "pending_ai_sow"]
            }
        };

        const zendeskSubdomain = process.env.ZENDESK_SUBDOMAIN;
        const zendeskEmail = process.env.ZENDESK_EMAIL;
        const zendeskToken = process.env.ZENDESK_API_TOKEN;

        if (!zendeskSubdomain || !zendeskEmail || !zendeskToken) {
            console.warn('⚠️ Zendesk credentials missing in .env. Simulating ticket creation.');
            console.log('Received SOW Data:', zendeskData);
            return res.status(201).json({ success: true, message: 'Simulated ticket created successfully!' });
        }

        const credentials = Buffer.from(`${zendeskEmail}/token:${zendeskToken}`).toString('base64');
        const zendeskResponse = await fetch(`https://${zendeskSubdomain}.zendesk.com/api/v2/tickets.json`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${credentials}`
            },
            body: JSON.stringify(zendeskData)
        });

        if (!zendeskResponse.ok) {
            const errText = await zendeskResponse.text();
            console.error('Zendesk API Error:', errText);
            return res.status(502).json({ error: 'Failed to create Zendesk ticket.' });
        }

        const responseData = await zendeskResponse.json();
        console.log(`✅ Zendesk ticket created successfully: #${responseData.ticket.id}`);

        return res.status(201).json({ success: true, ticketId: responseData.ticket.id });

    } catch (error) {
        console.error('Server Error:', error);
        return res.status(500).json({ error: 'Internal server error.' });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 SOW Intake Server running at http://localhost:${PORT}`);
});