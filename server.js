const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();
const { checkpoints, requiredForStart, MAX_FOLLOW_UPS_PER_ITEM } = require('./intake-question-config');
const { nextQuestion, evaluateAnswer, validateSession } = require('./ai-evaluator');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: '1mb' }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

let zendeskAccessToken = null;
let zendeskTokenExpiresAt = 0;
async function getZendeskAccessToken() {
  if (zendeskAccessToken && Date.now() < zendeskTokenExpiresAt - 60000) return zendeskAccessToken;
  const response = await fetch(`https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/oauth/tokens`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: process.env.ZENDESK_CLIENT_ID, client_secret: process.env.ZENDESK_CLIENT_SECRET, scope: 'tickets:write' })
  });
  const data = await response.json().catch(()=>({}));
  if (!response.ok || !data.access_token) { console.error('Zendesk OAuth error:', data); throw new Error('Zendesk authentication failed.'); }
  zendeskAccessToken = data.access_token; zendeskTokenExpiresAt = Date.now() + Number(data.expires_in || 3600) * 1000;
  return zendeskAccessToken;
}

app.get('/api/intake-config', (_req,res) => res.json({ checkpoints, maxFollowUpsPerItem: MAX_FOLLOW_UPS_PER_ITEM }));

app.post('/api/next-question', async (req,res) => {
  try {
    const { checkpointId, projectType, projectDescription, sessionDetails, history } = req.body || {};
    if (typeof checkpointId !== 'string' || !checkpoints.some(c=>c.id===checkpointId)) return res.status(400).json({ success:false, error:'Invalid checkpoint.' });
    const result = await nextQuestion({ checkpointId, projectType, projectDescription, sessionDetails, history });
    res.json({ success:true, ...result });
  } catch (error) { console.error('Next question error:',error); res.status(500).json({success:false,error:'Unable to generate the next question. Please try again.'}); }
});

app.post('/api/evaluate-dynamic-answer', async (req,res) => {
  try {
    const { checkpointId, question, answer, projectType, projectDescription, sessionDetails, history, targetItemIds, followUpCounts } = req.body || {};
    if (typeof checkpointId!=='string' || typeof question!=='string' || typeof answer!=='string' || !answer.trim()) return res.status(400).json({success:false,error:'A question and answer are required.'});
    const result = await evaluateAnswer({ checkpointId, question, answer, projectType, projectDescription, sessionDetails, history, targetItemIds, followUpCounts });
    res.json({success:true,evaluation:result});
  } catch(error) { console.error('Dynamic evaluation error:',error); res.status(500).json({success:false,error:'Unable to evaluate this answer. Please try again.'}); }
});

app.post('/api/validate-intake', async (req,res) => {
  try {
    const data = req.body || {};
    if (!Array.isArray(data.answers)) return res.status(400).json({ success:false, error:'No discovery answers were provided for validation.' });
    const coverage = new Map();
    for (const answer of data.answers) {
      const ids = Array.isArray(answer.coveredItemIds) ? answer.coveredItemIds : [];
      for (const id of ids) {
        const prior = coverage.get(id) || [];
        prior.push(answer);
        coverage.set(id, prior);
      }
    }
    const requiredLabels = new Map(checkpoints.flatMap(cp => cp.items.map(item => [item.id, `${cp.title}: ${item.label}`])));
    const missingRequired = requiredForStart.filter(id => {
      const records = coverage.get(id) || [];
      return !records.some(a => ['answered','accepted','delegated'].includes(a.status) && String(a.answer || '').trim() && !a.needsReview && a.status !== 'unknown');
    }).map(id => ({ id, label: requiredLabels.get(id) || id }));
    const unresolved = checkpoints.flatMap(cp => cp.items.map(item => ({ cp, item }))).filter(({item}) => {
      const records = coverage.get(item.id) || [];
      return !records.length || records.every(a => a.status === 'unknown' || a.needsReview);
    }).map(({cp,item}) => ({ id:item.id, label:`${cp.title}: ${item.label}`, required:requiredForStart.includes(item.id) }));
    const audit = await validateSession({ session:data });
    const contradictions = [...new Set([...(audit.contradictions || []), ...(data.answers || []).flatMap(a => a.evaluation?.contradictions || [])])];
    const blockingIssues = [];
    const warnings = [
      ...missingRequired.map(x => `Required project detail still missing or unverified: ${x.label}`),
      ...unresolved.map(x => `Unresolved checklist item: ${x.label}`),
      ...(audit.warnings || []),
      ...(audit.missingCriticalDetails || []).map(x => `AI audit follow-up: ${x}`),
      ...contradictions.map(x => `Potential contradiction to review: ${x}`)
    ];
    // Discovery warnings are recorded for the delivery team, but do not block ticket submission.
    res.json({ success:true, canSubmit:true, blockingIssues, missingRequired, unresolvedOptional:unresolved.filter(x=>!x.required), contradictions, warnings, auditFallback:Boolean(audit.auditFallback) });
  } catch (error) {
    console.error('Final validation error:', error);
    res.status(500).json({ success:false, error:'Final validation could not complete. Please retry.' });
  }
});

function safeText(value, max=5000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function compactFallback(value, max=500) {
  return safeText(value, max)
    .replace(/^(Ryan|the client)\s+(says|wants|reports|states|requires)\s+/i, '')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '');
}

function dateOnly(value) {
  const text = safeText(value, 1000);
  const match = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})\b/i);
  return match ? `${match[1][0].toUpperCase()}${match[1].slice(1).toLowerCase()} ${match[2]}` : '';
}

async function generateConciseTicketSummary(data) {
  const answers = Array.isArray(data.answers) ? data.answers : [];
  const validation = data.validationReport || {};
  const answerForItem = (id) => answers.find(a => Array.isArray(a.coveredItemIds) && a.coveredItemIds.includes(id));
  const extractDateFor = (id) => {
    const a = answerForItem(id);
    const source = a ? `${safeText(a.answer, 1500)} ${safeText(a.mainPoint || a.evaluation?.mainPoint, 700)}` : '';
    const matches = [...source.matchAll(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})\b/gi)]
      .map(m => `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}`);
    if (!matches.length) return '';
    return id === 'go_live' ? matches[matches.length - 1] : matches[0];
  };
  const answerContext = answers.map((a, index) => ({
    number: index + 1,
    checkpoint: safeText(a.checkpointTitle || a.checkpointId, 100),
    question: safeText(a.question, 700),
    originalAnswer: safeText(a.answer, 1800),
    capturedMainPoint: safeText(a.mainPoint || a.evaluation?.mainPoint, 700),
    status: safeText(a.status || a.evaluation?.disposition, 40) || 'answered',
    reason: safeText(a.reason || a.evaluation?.reason, 300),
    needsReview: Boolean(a.needsReview || a.evaluation?.needsReview || a.evaluation?.fallback),
    coveredItemIds: Array.isArray(a.coveredItemIds) ? a.coveredItemIds : []
  }));

  // Use the original answers as the source of truth. This prevents an incomplete
  // AI "main point" from silently dropping systems, dates, counts, or constraints.
  if (process.env.OPENAI_API_KEY && (process.env.AI_PROVIDER || '').toLowerCase() !== 'mock') {
    try {
      const OpenAI = require('openai');
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 35000, maxRetries: 0 });
      const response = await client.responses.create({
        model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
        instructions: `You are preparing a concise internal presales handover ticket from discovery meeting notes.
Use the ORIGINAL client answers as the source of truth; captured main points are secondary hints and may be incomplete.
Write only the main points. Do not write "Ryan says", "the client wants", "the client reports", or repeat the questions.
Be concise and factual: short phrases or bullets, not paragraphs.
Preserve all concrete facts: exact month/year dates, quantities, named platforms, communication channels, operating hours, targets, constraints, and caveats.
IMPORTANT RECONCILIATION RULE: If an earlier answer names several systems and a later follow-up clarifies the role of one system, keep all the named systems unless the client explicitly says a system is no longer in scope. Example: "CRM, Five9, and Confluence" followed by "Microsoft CRM is the ticketing platform" should become "Microsoft CRM (ticketing), Five9 (telephony), Confluence (knowledge base)"—do not drop Five9 or Confluence.
For dates, output only the date value, e.g. "January 2027" and "April 2027"; never repeat the same combined sentence under two date fields.
Do not invent missing details or turn suggestions into confirmed requirements. Put unknown, delegated, accepted-as-is, or needs-review items in internalFollowUps, with the correct distinction.
Remove duplicate points. Avoid generic filler. If a field is not supported, return an empty string or empty array.
Use the company/contact/project details only in the project header, not repeated in the requirement bullets.`,
        input: JSON.stringify({
          project: {
            projectName: safeText(data.projectName, 180),
            company: safeText(data.companyName, 150),
            contact: safeText(data.contactName, 100),
            email: safeText(data.contactEmail, 254),
            projectType: safeText(data.projectType, 150),
            description: safeText(data.projectDescription, 1000)
          },
          originalDiscoveryAnswers: answerContext,
          validation: {
            missingRequired: Array.isArray(validation.missingRequired) ? validation.missingRequired : [],
            unresolvedOptional: Array.isArray(validation.unresolvedOptional) ? validation.unresolvedOptional : [],
            warnings: Array.isArray(validation.warnings) ? validation.warnings : [],
            contradictions: Array.isArray(validation.contradictions) ? validation.contradictions : []
          }
        }),
        text: { format: { type: 'json_schema', name: 'concise_sow_handover', strict: true, schema: {
          type: 'object',
          properties: {
            objective: { type: 'string' },
            businessRequirements: { type: 'array', items: { type: 'string' } },
            functionalRequirements: { type: 'array', items: { type: 'string' } },
            systemsAndData: { type: 'array', items: { type: 'string' } },
            operations: { type: 'array', items: { type: 'string' } },
            startDate: { type: 'string' },
            goLiveDate: { type: 'string' },
            budget: { type: 'string' },
            deliverables: { type: 'array', items: { type: 'string' } },
            acceptance: { type: 'array', items: { type: 'string' } },
            internalFollowUps: { type: 'array', items: { type: 'string' } }
          },
          required: ['objective','businessRequirements','functionalRequirements','systemsAndData','operations','startDate','goLiveDate','budget','deliverables','acceptance','internalFollowUps'],
          additionalProperties: false
        } } },
        max_output_tokens: 1100
      });
      const result = JSON.parse(response.output_text || '{}');
      // Keep dates as short values, even if the model returns a full sentence.
      result.startDate = extractDateFor('start_date') || compactFallback(result.startDate, 100);
      result.goLiveDate = extractDateFor('go_live') || compactFallback(result.goLiveDate, 100);
      return result;
    } catch (error) {
      console.error('Concise Zendesk summary fallback:', error.message);
    }
  }

  // Prototype/offline fallback: use saved main points, but normalize wording and dates.
  const findAnswer = (id) => answers.find(a => Array.isArray(a.coveredItemIds) && a.coveredItemIds.includes(id));
  const raw = (id) => {
    const a = findAnswer(id);
    return a ? safeText(a.answer, 1500) : '';
  };
  const point = (id) => {
    const a = findAnswer(id);
    return a ? compactFallback(a.mainPoint || a.evaluation?.mainPoint || a.answer) : '';
  };
  const dateValue = (id) => extractDateFor(id) || point(id);
  const unique = (ids) => [...new Set(ids.map(point).filter(Boolean))];
  const followUps = [];
  for (const a of answers) {
    const status = a.status || a.evaluation?.disposition;
    const itemId = (a.coveredItemIds || [])[0];
    const cp = checkpoints.find(c => c.items.some(i => i.id === itemId));
    const item = cp?.items.find(i => i.id === itemId);
    const label = item?.label || safeText(a.question, 120) || 'Discovery detail';
    if (status === 'unknown') followUps.push(`${label}: Client does not know yet${a.reason ? ` (${safeText(a.reason, 180)})` : ''}.`);
    if (status === 'delegated') followUps.push(`${label}: Client requests a delivery-team recommendation.`);
    if (a.needsReview || a.evaluation?.needsReview || a.evaluation?.fallback) followUps.push(`${label}: Needs internal review.`);
  }
  const missing = [...(validation.missingRequired || []), ...(validation.unresolvedOptional || [])];
  missing.forEach(x => followUps.push(`${safeText(x.label || x.id, 180)}: Not yet confirmed.`));

  const systemAnswers = answers.filter(a => (a.coveredItemIds || []).some(id => ['systems','integrations'].includes(id)));
  const allSystemText = systemAnswers.map(a => safeText(a.answer, 1500)).join(' ');
  const knownSystems = [];
  if (/microsoft\s*crm|microsoft dynamics|dynamics\s*365|crm/i.test(allSystemText)) knownSystems.push(/microsoft/i.test(allSystemText) ? 'Microsoft CRM' : 'CRM');
  if (/five9/i.test(allSystemText)) knownSystems.push('Five9');
  if (/confluence/i.test(allSystemText)) knownSystems.push('Confluence');
  const systemsAndData = [...new Set(knownSystems)];
  const sections = {
    objective: point('problem'),
    businessRequirements: unique(['current_process','pain_points','use_cases','success_criteria']),
    functionalRequirements: unique(['capabilities','automation','ai_routing','users','channels']),
    systemsAndData: [...systemsAndData, ...unique(['migration','security','tech_stack_preference'])],
    operations: unique(['volume','hours','reporting','availability']),
    startDate: dateValue('start_date'),
    goLiveDate: dateValue('go_live'),
    budget: point('budget'),
    deliverables: unique(['deliverables']),
    acceptance: unique(['acceptance']),
    internalFollowUps: [...new Set(followUps)]
  };
  return sections;
}

async function formatTicket(data) {
  const projectName = safeText(data.projectName,180) || `${safeText(data.companyName,150)} - ${safeText(data.projectType,150)}`;
  const summary = await generateConciseTicketSummary(data);
  const lines = [
    `SOW DISCOVERY — ${projectName}`,
    '',
    'PROJECT DETAILS',
    `Company: ${safeText(data.companyName,150) || 'Not provided'}`,
    `Contact: ${safeText(data.contactName,100) || 'Not provided'}${safeText(data.contactEmail,254) ? ` | ${safeText(data.contactEmail,254)}` : ''}`,
    `Project type: ${safeText(data.projectType,150) || 'Not provided'}`
  ];
  if (summary.objective) lines.push('', 'PROJECT OBJECTIVE', `- ${summary.objective}`);

  const addList = (title, values) => {
    const items = Array.isArray(values) ? [...new Set(values.map(x => safeText(x, 450)).filter(Boolean))] : [];
    if (items.length) lines.push('', title, ...items.map(x => `- ${x}`));
  };
  addList('BUSINESS REQUIREMENTS', summary.businessRequirements);
  addList('FUNCTIONAL REQUIREMENTS', summary.functionalRequirements);
  addList('SYSTEMS & DATA', summary.systemsAndData);
  addList('OPERATIONS & SERVICE LEVELS', summary.operations);

  if (summary.startDate || summary.goLiveDate) {
    lines.push('', 'TIMELINE');
    if (summary.startDate) lines.push(`- Start: ${summary.startDate}`);
    if (summary.goLiveDate) lines.push(`- Go-live: ${summary.goLiveDate}`);
  }
  if (summary.budget) lines.push('', 'BUDGET', `- ${summary.budget}`);
  addList('DELIVERABLES', summary.deliverables);
  addList('ACCEPTANCE CRITERIA', summary.acceptance);

  const followUps = Array.isArray(summary.internalFollowUps) ? [...new Set(summary.internalFollowUps.map(x => safeText(x, 400)).filter(Boolean))] : [];
  const warnings = Array.isArray(data.validationReport?.warnings) ? data.validationReport.warnings : [];
  const meaningfulWarnings = warnings
    .map(w => safeText(w, 350))
    .filter(w => w && !w.startsWith('Required project detail still missing or unverified:') && !w.startsWith('Unresolved checklist item:') && !w.startsWith('AI audit follow-up:'));
  for (const warning of meaningfulWarnings) if (!followUps.some(x => x.toLowerCase() === warning.toLowerCase())) followUps.push(warning);
  const missingDetails = [
    ...(Array.isArray(data.validationReport?.missingRequired) ? data.validationReport.missingRequired : []),
    ...(Array.isArray(data.validationReport?.unresolvedOptional) ? data.validationReport.unresolvedOptional : [])
  ];
  for (const item of missingDetails) {
    const label = safeText(item.label || item.id, 250);
    if (label && !followUps.some(x => x.toLowerCase().includes(label.toLowerCase()))) {
      followUps.push(`${label}: Not yet confirmed.`);
    }
  }
  const contradictions = Array.isArray(data.validationReport?.contradictions) ? data.validationReport.contradictions : [];
  contradictions.forEach(x => {
    const item = `Potential inconsistency: ${safeText(x, 300)}`;
    if (!followUps.some(y => y.toLowerCase() === item.toLowerCase())) followUps.push(item);
  });

  lines.push('', 'INTERNAL TEAM FOLLOW-UP');
  if (followUps.length) lines.push(...followUps.map(x => `- ${x}`));
  else lines.push('- No outstanding follow-up items recorded.');
  lines.push('', 'Submission: Submitted for internal review.');
  return lines.join('\n');
}

app.post('/api/submit-intake', async (req,res) => {
  try {
    const data=req.body;
    if (!data || typeof data!=='object' || Array.isArray(data)) return res.status(400).json({success:false,error:'Invalid submission.'});
    const required=['clientName','companyName','contactName','contactEmail','projectType'];
    const missing=required.filter(k=>!safeText(data[k],500));
    if (missing.length) return res.status(400).json({success:false,error:`Please complete: ${missing.join(', ')}.`});
    const email=safeText(data.contactEmail,254);
    const emailPattern=/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i;
    if(!emailPattern.test(email)) return res.status(400).json({success:false,error:'Please enter a valid contact email.'});
    if(!Array.isArray(data.answers) || data.answers.length===0) return res.status(400).json({success:false,error:'No discovery answers were recorded.'});
    // Do not block Zendesk submission for discovery gaps or validation warnings.
    // Only actual submission requirements (contact details, an answer record, and Zendesk availability) are enforced here.
    const ticketBody=await formatTicket(data);
    const token=await getZendeskAccessToken();
    const zd=await fetch(`https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets.json`,{
      method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},
      body:JSON.stringify({ticket:{subject:`[SOW Discovery] - ${safeText(data.projectName,180) || safeText(data.companyName,150) + ' - ' + safeText(data.projectType,100)}`,requester:{name:safeText(data.contactName,100),email},comment:{body:ticketBody,public:false},status:'new',tags:['sow_intake','presales_discovery','pending_sow_review']}})
    });
    const zdData=await zd.json().catch(()=>null);
    if(!zd.ok || !zdData?.ticket?.id){console.error('Zendesk ticket error:',zdData);return res.status(502).json({success:false,error:'Zendesk could not create the ticket. Please check the integration settings and try again.'});}
    const ticket=zdData.ticket;
    res.status(201).json({success:true,message:'SOW discovery submitted to Zendesk.',ticketId:ticket.id,ticketStatus:ticket.status,zendeskUrl:`https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/agent/tickets/${ticket.id}`});
  } catch(error){console.error('Submission error:',error);res.status(500).json({success:false,error:'Unable to submit the intake. Please try again.'});}
});

app.listen(PORT,()=>console.log(`SOW Intake Server running at http://localhost:${PORT}`));
