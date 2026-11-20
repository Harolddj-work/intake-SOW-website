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

function safeText(value, max=5000) { return typeof value==='string' ? value.trim().slice(0,max) : ''; }
function formatTicket(data) {
  const projectName = safeText(data.projectName,180) || `${safeText(data.companyName,150)} - ${safeText(data.projectType,150)}`;
  const findPoint = (itemId) => {
    const a = (data.answers || []).find(x => (x.coveredItemIds || []).includes(itemId));
    return a ? safeText(a.mainPoint || a.evaluation?.mainPoint || a.answer, 1800) : 'Not captured';
  };
  const lines = [
    'SOW DISCOVERY INTAKE — STRUCTURED PROJECT BRIEF', '',
    '==================================================', 'PROJECT SNAPSHOT', '==================================================',
    `Project name: ${projectName}`,
    `Client / sponsor: ${safeText(data.clientName,150)}`,
    `Company: ${safeText(data.companyName,150)}`,
    `Primary contact: ${safeText(data.contactName,100)}`,
    `Contact email: ${safeText(data.contactEmail,254)}`,
    `Project type: ${safeText(data.projectType,150)}`,
    `Project description: ${safeText(data.projectDescription,3000) || 'Not provided'}`,
    `Target start date: ${findPoint('start_date')}`,
    `Target go-live date: ${findPoint('go_live')}`,
    `Technology stack preference: ${findPoint('tech_stack_preference')}`,
    `Existing systems: ${findPoint('systems')}`,
    `Integrations: ${findPoint('integrations')}`,
    `Security / compliance: ${findPoint('security')}`,
    `Expected volumes: ${findPoint('volume')}`,
    `Operating hours / coverage: ${findPoint('hours')}`,
    `Budget: ${findPoint('budget')}`,
    `Business problem: ${findPoint('problem')}`,
    `Primary use cases: ${findPoint('use_cases')}`,
    `Success criteria: ${findPoint('success_criteria')}`,
    `Key stakeholders / approvers: ${findPoint('stakeholders')}`,
    `Core deliverables: ${findPoint('deliverables')}`,
    `Acceptance / sign-off: ${findPoint('acceptance')}`,
    '', '==================================================', 'FINAL VALIDATION / HANDOVER FLAGS', '=================================================='
  ];
  const validation = data.validationReport || {};
  const validationWarnings = Array.isArray(validation.warnings) ? validation.warnings : [];
  const missingRequired = Array.isArray(validation.missingRequired) ? validation.missingRequired : [];
  if (missingRequired.length) lines.push('Required items still missing or unverified:', ...missingRequired.map(x => `- ${safeText(x.label || x.id,500)}`));
  if (validationWarnings.length) lines.push('Review warnings:', ...validationWarnings.map(x => `- ${safeText(x,1000)}`));
  if (!missingRequired.length && !validationWarnings.length) lines.push('No outstanding validation warnings were recorded.');
  lines.push('', 'Submission status: Submitted with any outstanding warnings retained for project-team review.', '', '==================================================', 'DETAILED DISCOVERY BY CHECKPOINT', '==================================================');
  for (const cp of checkpoints) {
    lines.push('', '--------------------------------------------------', cp.title.toUpperCase(), '--------------------------------------------------');
    const checkpointNote = safeText(data.checkpointNotes?.[cp.id], 3000);
    if (checkpointNote) lines.push('', 'ADDITIONAL CHECKPOINT NOTES:', checkpointNote);
    const entries = (data.answers || []).filter(a=>a.checkpointId===cp.id);
    if (!entries.length) { lines.push('No responses recorded.'); continue; }
    entries.forEach((a,index)=>{
      lines.push('', `${index+1}. ${safeText(a.question,2000)}`, `Client / presales answer: ${safeText(a.answer,5000) || 'No answer'}`);
      if (a.mainPoint || a.evaluation?.mainPoint) lines.push(`Captured main point: ${safeText(a.mainPoint || a.evaluation.mainPoint,1800)}`);
      if (a.status==='unknown') lines.push(`FLAG: CLIENT DOES NOT KNOW YET — ${safeText(a.reason,1000) || 'No reason provided'}`);
      if (a.status==='delegated') lines.push('FLAG: CLIENT DELEGATED THIS DECISION TO THE DELIVERY TEAM');
      if (a.status==='accepted') lines.push('FLAG: PRESALES ACCEPTED ANSWER AS-IS — requires review');
      if (a.evaluation?.assessment) lines.push(`AI assessment: ${safeText(a.evaluation.assessment,1500)}`);
      if (a.evaluation?.contradictions?.length) lines.push(`Potential contradictions: ${a.evaluation.contradictions.map(x=>safeText(x,500)).join('; ')}`);
      if (a.followUpQuestion) lines.push(`Follow-up asked: ${safeText(a.followUpQuestion,1000)}`);
      if (a.followUpAnswer) lines.push(`Follow-up answer: ${safeText(a.followUpAnswer,3000)}`);
      if (a.needsReview || a.evaluation?.needsReview || a.evaluation?.fallback) lines.push('FLAG: NEEDS PROJECT TEAM REVIEW');
    });
  }
  lines.push('', 'END OF DISCOVERY INTAKE');
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
    const ticketBody=formatTicket(data);
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
