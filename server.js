// Dependencies
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

require('dotenv').config();

const { checkpoints, requiredForStart, MAX_FOLLOW_UPS_PER_ITEM } = require('./intake-question-config');
const { nextQuestion, evaluateAnswer, validateSession, validateTimelineAnswers } = require('./ai-evaluator');

// Application configuration
const app = express();
app.use(express.json({ limit: '1mb' }));
const PORT = process.env.PORT || 3000;
const supabaseUrl = process.env.SUPABASE_URL;
const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabasePublishableKey || !supabaseSecretKey) {
  throw new Error('Missing SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, or SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY) in .env');
}

let zendeskAccessToken = null;
let zendeskTokenExpiresAt = 0;

// Supabase clients
// Used to verify user tokens.
const authVerifier = createClient(
  supabaseUrl,
  supabasePublishableKey,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
);

// Used only for trusted admin operations, such as invitations.
const supabaseAdmin = createClient(
  supabaseUrl,
  supabaseSecretKey,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
);

// Application middleware
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Authentication middleware
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ')
      ? header.slice(7)
      : null;

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required.'
      });
    }

    const { data, error } =
      await authVerifier.auth.getUser(token);

    if (error || !data.user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired login session.'
      });
    }

    // Create a database client scoped to this user's JWT.
    const userDb = createClient(
      supabaseUrl,
      supabasePublishableKey,
      {
        global: {
          headers: {
            Authorization: `Bearer ${token}`
          }
        },
        auth: {
          persistSession: false,
          autoRefreshToken: false
        }
      }
    );

    const { data: profile, error: profileError } =
      await userDb
        .from('profiles')
        .select('id, role, is_active, password_setup_completed')
        .eq('id', data.user.id)
        .single();

    if (profileError || !profile || !profile.is_active) {
      return res.status(403).json({
        success: false,
        error: 'Your account is inactive or not authorized.'
      });
    }

    // Pending invitees may call only the password-setup completion endpoint.
    // Every other protected API route is denied until setup is complete.
    const isPasswordSetupRoute =
      req.method === 'PATCH' && req.path === '/api/me/password-setup';
    if (!profile.password_setup_completed && !isPasswordSetupRoute) {
      return res.status(403).json({
        success: false,
        code: 'ACCOUNT_SETUP_PENDING',
        error: 'Your account is pending setup. Create your password using your invitation link before signing in.'
      });
    }

    req.user = {
      id: data.user.id,
      email: data.user.email,
      role: profile.role,
      password_setup_completed: Boolean(profile.password_setup_completed)
    };

    req.db = userDb;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(500).json({
      success: false,
      error: 'Authentication could not be completed.'
    });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({
      success: false,
      error: 'Administrator access required.'
    });
  }

  next();
}

// Public browser configuration. Only the URL and publishable key may be exposed.
app.get('/api/public-config', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    success: true,
    supabaseUrl,
    supabasePublishableKey
  });
});

// Small helpers for the database-backed session workflow.
const ACTIVE_STATUSES = ['draft', 'in_progress', 'review'];

const SESSION_FIELDS = [
  'client_name', 'company_name', 'contact_name', 'contact_email',
  'project_name', 'project_type', 'project_description',
  'checkpoint_index', 'max_checkpoint_index', 'checkpoint_notes',
  'follow_up_counts', 'status', 'visibility', 'team_id'
];


function dbError(error, res, message = 'Database operation failed.') {
  console.error('Supabase database error:', {
    code: error?.code,
    message: error?.message,
    details: error?.details,
    hint: error?.hint
  });

  const status =
    error?.code === '23505' ? 409 :
      error?.code === '23503' ? 400 :
        error?.code === '23502' ? 400 :
          error?.code === '42501' ? 403 :
            500;

  return res.status(status).json({
    success: false,
    error: message,
    code: error?.code || 'DATABASE_ERROR'
  });
}


async function getSessionRecord(id) {
  const { data, error } = await supabaseAdmin
    .from('discovery_sessions')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function isTeamMember(userId, teamId) {
  if (!teamId) return false;

  const { data, error } = await supabaseAdmin
    .from('team_members')
    .select('user_id')
    .eq('user_id', userId)
    .eq('team_id', teamId)
    .maybeSingle();

  if (error) throw error;
  return Boolean(data);
}

async function canAccessSession(user, record) {
  if (!record || !user) return false;
  if (user.role === 'admin' || record.owner_id === user.id) return true;

  return record.visibility === 'team' &&
    await isTeamMember(user.id, record.team_id);
}

async function sessionWithAnswers(id) {
  const record = await getSessionRecord(id);
  if (!record) return null;

  const { data: answers, error } = await supabaseAdmin
    .from('discovery_answers')
    .select('*')
    .eq('session_id', id)
    .order('sequence_number', { ascending: true });

  if (error) throw error;

  return {
    ...record,
    answers: (answers || []).map(row => ({
      ...row,
      checkpointId: row.checkpoint_id,
      coveredItemIds: row.covered_item_ids || [],
      handledItemIds: row.handled_item_ids || [],
      followUpQuestion: row.follow_up_question,
      followUpAnswer: row.follow_up_answer,
      followUpMainPoint: row.follow_up_main_point,
      mainPoint: row.main_point,
      needsReview: row.needs_review,
      evaluation: row.evaluation || undefined
    }))
  };
}

async function addSessionDisplayFields(rows) {
  const ownerIds = [...new Set(rows.map(r => r.owner_id).filter(Boolean))];
  const teamIds = [...new Set(rows.map(r => r.team_id).filter(Boolean))];

  const [profilesResult, teamsResult] = await Promise.all([
    ownerIds.length
      ? supabaseAdmin.from('profiles').select('id, full_name').in('id', ownerIds)
      : Promise.resolve({ data: [], error: null }),

    teamIds.length
      ? supabaseAdmin.from('teams').select('id, name').in('id', teamIds)
      : Promise.resolve({ data: [], error: null })
  ]);

  if (profilesResult.error) throw profilesResult.error;
  if (teamsResult.error) throw teamsResult.error;

  const profiles = new Map((profilesResult.data || []).map(x => [x.id, x]));
  const teams = new Map((teamsResult.data || []).map(x => [x.id, x]));

  return rows.map(row => ({
    ...row,
    owner: profiles.get(row.owner_id) || null,
    owner_name: profiles.get(row.owner_id)?.full_name || null,
    team: teams.get(row.team_id) || null,
    team_name: teams.get(row.team_id)?.name || null
  }));
}

// Current signed-in user's profile.
app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, role, is_active, password_setup_completed')
      .eq('id', req.user.id)
      .single();

    if (error) throw error;

    res.json({
      success: true,
      user: { id: req.user.id, email: req.user.email },
      profile: { ...profile, password_setup_completed: Boolean(profile.password_setup_completed) },
      role: profile.role
    });
  } catch (error) {
    dbError(error, res, 'Unable to load your employee profile.');
  }
});

// Employee team list (admins can also use this route).
async function sendTeams(req, res) {
  try {
    let query = supabaseAdmin
      .from('teams')
      .select('id, name')
      .order('name');

    if (req.user.role !== 'admin') {
      const { data: memberships, error: memberError } = await supabaseAdmin
        .from('team_members')
        .select('team_id')
        .eq('user_id', req.user.id);

      if (memberError) throw memberError;

      const ids = (memberships || []).map(x => x.team_id);

      if (!ids.length) {
        return res.json({ success: true, teams: [] });
      }

      query = query.in('id', ids);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, teams: data || [] });
  } catch (error) {
    dbError(error, res, 'Unable to load teams.');
  }
}

app.get('/api/teams', requireAuth, sendTeams);
app.get('/api/admin/teams', requireAuth, requireAdmin, sendTeams);



// Create a discovery session. A presales employee may have only one active session.
app.post('/api/sessions', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'presales') {
      return res.status(403).json({
        success: false,
        error: 'Only presales employees can create discovery sessions.'
      });
    }

    const body = req.body || {};
    const value = (snake, camel) => body[snake] ?? body[camel];

    const requiredFields = [
      ['client_name', 'clientName'],
      ['company_name', 'companyName'],
      ['contact_name', 'contactName'],
      ['contact_email', 'contactEmail'],
      ['project_type', 'projectType']
    ];

    for (const [field, camel] of requiredFields) {
      if (!safeText(value(field, camel), 500)) {
        return res.status(400).json({
          success: false,
          error: `Missing required field: ${field}.`
        });
      }
    }

    // Check whether the employee already has an active session.
    const { data: active, error: activeError } = await supabaseAdmin
      .from('discovery_sessions')
      .select('id')
      .eq('owner_id', req.user.id)
      .in('status', ACTIVE_STATUSES)
      .limit(1);

    if (activeError) throw activeError;

    if (active && active.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'You already have an active discovery session. Resume or finish it before starting another.',
        activeSessionId: active[0].id
      });
    }

    const visibility = body.visibility === 'team' ? 'team' : 'private';
    const teamId = visibility === 'team'
      ? (body.team_id || body.teamId || null)
      : null;

    if (visibility === 'team' && !(await isTeamMember(req.user.id, teamId))) {
      return res.status(403).json({
        success: false,
        error: 'You must belong to the selected team to share this session.'
      });
    }

    const insert = {
      owner_id: req.user.id,
      client_name: safeText(value('client_name', 'clientName'), 180),
      company_name: safeText(value('company_name', 'companyName'), 180),
      contact_name: safeText(value('contact_name', 'contactName'), 120),
      contact_email: safeText(value('contact_email', 'contactEmail'), 254),
      project_name: safeText(value('project_name', 'projectName'), 180),
      project_type: safeText(value('project_type', 'projectType'), 180),
      project_description: safeText(value('project_description', 'projectDescription'), 3000),
      checkpoint_index: 0,
      max_checkpoint_index: 0,
      checkpoint_notes: {},
      follow_up_counts: {},
      status: 'draft',
      visibility,
      team_id: teamId
    };

    const { data, error } = await supabaseAdmin
      .from('discovery_sessions')
      .insert(insert)
      .select('*')
      .single();

    if (error) throw error;

    // Save any initial answers.
    const initialAnswers = Array.isArray(body.answers)
      ? body.answers
      : [];

    if (initialAnswers.length > 0) {
      const answerRows = initialAnswers.map((a, index) => ({
        session_id: data.id,
        sequence_number: index + 1,
        checkpoint_id: safeText(a.checkpointId || a.checkpoint_id, 100),
        question: safeText(a.question, 3000),
        answer: safeText(a.answer, 12000),
        status: safeText(a.status, 40) || 'answered',
        reason: safeText(a.reason, 2000),
        main_point: safeText(a.mainPoint || a.main_point, 3000),
        covered_item_ids: Array.isArray(a.coveredItemIds)
          ? a.coveredItemIds
          : [],
        handled_item_ids: Array.isArray(a.handledItemIds)
          ? a.handledItemIds
          : [],
        evaluation: a.evaluation && typeof a.evaluation === 'object'
          ? a.evaluation
          : {},
        needs_review: Boolean(a.needsReview),
        follow_up_question: safeText(a.followUpQuestion, 3000),
        follow_up_answer: safeText(a.followUpAnswer, 12000)
      }));

      const { error: answerError } = await supabaseAdmin
        .from('discovery_answers')
        .upsert(answerRows, {
          onConflict: 'session_id,sequence_number'
        });

      if (answerError) throw answerError;
    }

    return res.status(201).json({
      success: true,
      session: await sessionWithAnswers(data.id)
    });

  } catch (error) {
    console.error('Create session error:', error);

    return dbError(
      error,
      res,
      error.code === '23505'
        ? 'You already have an active discovery session.'
        : 'Unable to create discovery session.'
    );
  }
});

// List sessions visible to the signed-in employee (owned + shared with their teams).
app.get('/api/sessions', requireAuth, async (req, res) => {
  try {
    const { data: memberships, error: memberError } = await supabaseAdmin
      .from('team_members')
      .select('team_id')
      .eq('user_id', req.user.id);

    if (memberError) throw memberError;

    const teamIds = (memberships || []).map(x => x.team_id);

    let query = supabaseAdmin
      .from('discovery_sessions')
      .select('*')
      .order('updated_at', { ascending: false });

    if (teamIds.length) {
      query = query.or(
        `owner_id.eq.${req.user.id},and(visibility.eq.team,team_id.in.(${teamIds.join(',')}))`
      );
    } else {
      query = query.eq('owner_id', req.user.id);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({
      success: true,
      sessions: await addSessionDisplayFields(data || [])
    });
  } catch (error) {
    dbError(error, res, 'Unable to load your sessions.');
  }
});

app.get('/api/sessions/active', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('discovery_sessions')
      .select('*')
      .eq('owner_id', req.user.id)
      .in('status', ACTIVE_STATUSES)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.json({ success: true, session: null });
    }

    res.json({
      success: true,
      session: await sessionWithAnswers(data.id)
    });
  } catch (error) {
    dbError(error, res, 'Unable to load your active session.');
  }
});

app.get('/api/sessions/:id', requireAuth, async (req, res) => {
  try {
    const record = await getSessionRecord(req.params.id);

    if (!record) {
      return res.status(404).json({
        success: false,
        error: 'Session not found.'
      });
    }

    if (!(await canAccessSession(req.user, record))) {
      return res.status(403).json({
        success: false,
        error: 'You do not have access to this session.'
      });
    }

    const session = await sessionWithAnswers(record.id);
    const [display] = await addSessionDisplayFields([record]);

    res.json({
      success: true,
      session: {
        ...session,
        owner: display.owner,
        owner_name: display.owner_name,
        team: display.team
      }
    });
  } catch (error) {
    dbError(error, res, 'Unable to load this session.');
  }
});

app.patch('/api/sessions/:id', requireAuth, async (req, res) => {
  try {
    const record = await getSessionRecord(req.params.id);

    if (!record) {
      return res.status(404).json({
        success: false,
        error: 'Session not found.'
      });
    }

    if (!(await canAccessSession(req.user, record))) {
      return res.status(403).json({
        success: false,
        error: 'You do not have permission to edit this session.'
      });
    }

    const patch = {};

    for (const field of SESSION_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
        patch[field] = req.body[field];
      }
    }

    if (['submitted', 'completed', 'cancelled'].includes(record.status)) {
      if (patch.status === record.status && Object.keys(patch).length === 1) {
        return res.json({ success: true, session: record });
      }

      return res.status(409).json({
        success: false,
        error: 'This session is read-only.'
      });
    }

    if (patch.visibility && !['private', 'team'].includes(patch.visibility)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid session visibility.'
      });
    }

    if (
      patch.status &&
      !['draft', 'in_progress', 'review', 'submitted', 'completed', 'cancelled'].includes(patch.status)
    ) {
      return res.status(400).json({
        success: false,
        error: 'Invalid session status.'
      });
    }

    if (
      patch.visibility === 'team' ||
      (patch.team_id && patch.team_id !== record.team_id)
    ) {
      const teamId = patch.team_id || record.team_id;

      if (
        !(await isTeamMember(req.user.id, teamId)) &&
        req.user.role !== 'admin'
      ) {
        return res.status(403).json({
          success: false,
          error: 'You are not a member of that team.'
        });
      }
    }

    if (patch.visibility === 'private') {
      patch.team_id = null;
    }

    patch.updated_at = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from('discovery_sessions')
      .update(patch)
      .eq('id', record.id)
      .select('*')
      .single();

    if (error) throw error;

    res.json({ success: true, session: data });
  } catch (error) {
    dbError(error, res, 'Unable to save this session.');
  }
});

// Upsert by (session_id, sequence_number) so autosave retries never duplicate answers.
app.post('/api/sessions/:id/answers', requireAuth, async (req, res) => {
  try {
    const record = await getSessionRecord(req.params.id);

    if (!record) {
      return res.status(404).json({
        success: false,
        error: 'Session not found.'
      });
    }

    if (!(await canAccessSession(req.user, record))) {
      return res.status(403).json({
        success: false,
        error: 'You do not have permission to edit this session.'
      });
    }

    if (['submitted', 'completed', 'cancelled'].includes(record.status)) {
      return res.status(409).json({
        success: false,
        error: 'This session is read-only.'
      });
    }

    const a = req.body || {};
    const sequence = Number(a.sequence_number);

    if (!Number.isInteger(sequence) || sequence < 1 || !safeText(a.question, 3000)) {
      return res.status(400).json({
        success: false,
        error: 'A valid sequence number and question are required.'
      });
    }

    const row = {
      session_id: record.id,
      sequence_number: sequence,
      checkpoint_id: safeText(a.checkpointId || a.checkpoint_id, 100),
      question: safeText(a.question, 3000),
      answer: safeText(a.answer, 12000),
      status: safeText(a.status, 40) || 'answered',
      reason: safeText(a.reason, 2000),
      main_point: safeText(a.mainPoint || a.main_point, 3000),
      covered_item_ids: Array.isArray(a.coveredItemIds || a.covered_item_ids)
        ? (a.coveredItemIds || a.covered_item_ids)
        : [],
      handled_item_ids: Array.isArray(a.handledItemIds || a.handled_item_ids)
        ? (a.handledItemIds || a.handled_item_ids)
        : [],
      evaluation: a.evaluation && typeof a.evaluation === 'object'
        ? a.evaluation
        : {},
      needs_review: Boolean(a.needsReview ?? a.needs_review),
      follow_up_question: safeText(a.followUpQuestion || a.follow_up_question, 3000),
      follow_up_answer: safeText(a.followUpAnswer || a.follow_up_answer, 12000),
      follow_up_main_point: safeText(a.followUpMainPoint || a.follow_up_main_point, 3000),
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabaseAdmin
      .from('discovery_answers')
      .upsert(row, {
        onConflict: 'session_id,sequence_number'
      })
      .select('*')
      .single();

    if (error) throw error;

    res.status(200).json({ success: true, answer: data });
  } catch (error) {
    dbError(error, res, 'Unable to save this answer.');
  }
});

// Claiming a shared session transfers its active owner to the employee opening it.
app.post('/api/sessions/:id/claim', requireAuth, async (req, res) => {
  try {
    const record = await getSessionRecord(req.params.id);

    if (!record) {
      return res.status(404).json({
        success: false,
        error: 'Session not found.'
      });
    }

    if (record.owner_id === req.user.id) {
      return res.json({
        success: true,
        session: await sessionWithAnswers(record.id)
      });
    }

    if (
      record.visibility !== 'team' ||
      !(await isTeamMember(req.user.id, record.team_id))
    ) {
      return res.status(403).json({
        success: false,
        error: 'This session is not shared with your team.'
      });
    }

    if (!ACTIVE_STATUSES.includes(record.status)) {
      return res.status(409).json({
        success: false,
        error: 'Only active sessions can be claimed.'
      });
    }

    const { data: active, error: activeError } = await supabaseAdmin
      .from('discovery_sessions')
      .select('id')
      .eq('owner_id', req.user.id)
      .in('status', ACTIVE_STATUSES)
      .limit(1);

    if (activeError) throw activeError;

    if (active?.length) {
      return res.status(409).json({
        success: false,
        error: 'Finish your current active session before claiming another.'
      });
    }

    const { error } = await supabaseAdmin
      .from('discovery_sessions')
      .update({
        owner_id: req.user.id,
        updated_at: new Date().toISOString()
      })
      .eq('id', record.id);

    if (error) throw error;

    res.json({
      success: true,
      session: await sessionWithAnswers(record.id)
    });
  } catch (error) {
    dbError(error, res, 'Unable to claim this session.');
  }
});

// Admin: all employees with their team labels and account status.
app.get('/api/admin/employees', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const [
      { data: profiles, error: profileError },
      { data: memberships, error: memberError },
      { data: authUsers, error: authError }
    ] = await Promise.all([
      supabaseAdmin
        .from('profiles')
        .select('id, full_name, role, is_active, password_setup_completed')
        .order('full_name'),

      supabaseAdmin
        .from('team_members')
        .select('user_id, team_id, teams(name)'),

      supabaseAdmin.auth.admin.listUsers({
        page: 1,
        perPage: 1000
      })
    ]);

    if (profileError) throw profileError;
    if (memberError) throw memberError;
    if (authError) throw authError;

    const emails = new Map(
      (authUsers.users || []).map(u => [u.id, u.email])
    );

    const teamIdByUser = new Map();
    const teamsByUser = new Map();

    for (const m of memberships || []) {
      teamIdByUser.set(m.user_id, m.team_id);
      const prev = teamsByUser.get(m.user_id) || [];

      if (m.teams?.name) {
        prev.push(m.teams.name);
      }

      teamsByUser.set(m.user_id, prev);
    }

    res.json({
      success: true,
      employees: (profiles || []).map(p => ({
        ...p,
        email: emails.get(p.id) || '',
        team_id: teamIdByUser.get(p.id) || null,
        team_name: (teamsByUser.get(p.id) || []).join(', ') || 'No team',
        password_setup_completed: Boolean(p.password_setup_completed)
      }))
    });
  } catch (error) {
    dbError(error, res, 'Unable to load employees.');
  }
});

// Mark the invited account as fully set up after the user chooses a password.
app.patch('/api/me/password-setup', requireAuth, async (req, res) => {
  try {
    if (req.user.password_setup_completed) {
      return res.status(409).json({ success: false, error: 'Password setup has already been completed.' });
    }
    if (req.body?.completed !== true) {
      return res.status(400).json({ success: false, error: 'Password setup confirmation is required.' });
    }
    const { error } = await supabaseAdmin
      .from('profiles')
      .update({ password_setup_completed: true })
      .eq('id', req.user.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    dbError(error, res, 'Unable to update account setup status.');
  }
});

// Admin: change an employee's application role and single-team assignment.
app.patch('/api/admin/employees/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const { role, teamId = null } = req.body || {};
    if (!['admin', 'presales'].includes(role)) {
      return res.status(400).json({ success: false, error: 'Role must be admin or presales.' });
    }
    if (userId === req.user.id && role !== 'admin') {
      return res.status(400).json({ success: false, error: 'You cannot remove your own administrator access.' });
    }
    const { data: existing, error: existingError } = await supabaseAdmin
      .from('profiles').select('id, role').eq('id', userId).maybeSingle();
    if (existingError) throw existingError;
    if (!existing) return res.status(404).json({ success: false, error: 'Employee not found.' });
    if (existing.role === 'admin' && role !== 'admin') {
      const { count, error: countError } = await supabaseAdmin
        .from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'admin');
      if (countError) throw countError;
      if ((count || 0) <= 1) return res.status(409).json({ success: false, error: 'At least one administrator account must remain.' });
    }

    if (teamId) {
      const { data: team, error: teamError } = await supabaseAdmin
        .from('teams').select('id').eq('id', teamId).maybeSingle();
      if (teamError) throw teamError;
      if (!team) return res.status(400).json({ success: false, error: 'Selected team does not exist.' });
    }

    const { error: profileError } = await supabaseAdmin
      .from('profiles').update({ role }).eq('id', userId);
    if (profileError) throw profileError;

    const { error: removeMembershipError } = await supabaseAdmin
      .from('team_members').delete().eq('user_id', userId);
    if (removeMembershipError) throw removeMembershipError;

    if (teamId) {
      const { error: addMembershipError } = await supabaseAdmin
        .from('team_members').insert({ user_id: userId, team_id: teamId });
      if (addMembershipError) throw addMembershipError;
    }

    res.json({ success: true, message: 'Employee access updated.' });
  } catch (error) {
    dbError(error, res, 'Unable to update employee access.');
  }
});

// Admin: permanently remove the account from Supabase Auth and its owned intake records.
app.delete('/api/admin/employees/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    if (userId === req.user.id) {
      return res.status(400).json({ success: false, error: 'You cannot delete your own administrator account.' });
    }

    const { data: targetProfile, error: targetProfileError } = await supabaseAdmin
      .from('profiles').select('id, role').eq('id', userId).maybeSingle();
    if (targetProfileError) throw targetProfileError;
    if (!targetProfile) return res.status(404).json({ success: false, error: 'Employee not found.' });
    if (targetProfile.role === 'admin') {
      const { count, error: countError } = await supabaseAdmin
        .from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'admin');
      if (countError) throw countError;
      if ((count || 0) <= 1) return res.status(409).json({ success: false, error: 'The last administrator account cannot be deleted.' });
    }

    const { data: ownedSessions, error: sessionsError } = await supabaseAdmin
      .from('discovery_sessions').select('id').eq('owner_id', userId);
    if (sessionsError) throw sessionsError;
    const sessionIds = (ownedSessions || []).map(row => row.id);

    if (sessionIds.length) {
      const cleanup = await Promise.all([
        supabaseAdmin.from('discovery_answers').delete().in('session_id', sessionIds),
        supabaseAdmin.from('session_submissions').delete().in('session_id', sessionIds),
        supabaseAdmin.from('active_session_claims').delete().in('session_id', sessionIds),
        supabaseAdmin.from('discovery_sessions').delete().in('id', sessionIds)
      ]);
      const failed = cleanup.find(result => result.error);
      if (failed?.error) throw failed.error;
    }

    // Remove any claims/submissions created by this user on sessions owned by others.
    const dependentCleanup = await Promise.all([
      supabaseAdmin.from('active_session_claims').delete().eq('user_id', userId),
      supabaseAdmin.from('session_submissions').delete().eq('submitted_by', userId),
      supabaseAdmin.from('team_members').delete().eq('user_id', userId),
      supabaseAdmin.from('audit_logs').update({ user_id: null }).eq('user_id', userId)
    ]);
    const dependentFailure = dependentCleanup.find(result => result.error);
    if (dependentFailure?.error) throw dependentFailure.error;

    const { error: profileDeleteError } = await supabaseAdmin
      .from('profiles').delete().eq('id', userId);
    if (profileDeleteError) throw profileDeleteError;

    const { error: authDeleteError } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (authDeleteError) throw authDeleteError;

    res.json({ success: true, message: 'Employee and Supabase Auth account deleted.' });
  } catch (error) {
    dbError(error, res, 'Unable to delete this employee and Auth account.');
  }
});

app.get('/api/admin/sessions', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('discovery_sessions')
      .select('*')
      .order('updated_at', { ascending: false });

    if (error) throw error;

    res.json({
      success: true,
      sessions: await addSessionDisplayFields(data || [])
    });
  } catch (error) {
    dbError(error, res, 'Unable to load session tracking.');
  }
});

// Invite employee using the server-only Supabase secret key.
app.post('/api/admin/invites', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { email, fullName, role, teamId } = req.body || {};

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({
        success: false,
        error: 'A valid email is required.'
      });
    }

    const allowedRoles = ['admin', 'presales'];

    if (role && !allowedRoles.includes(role)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid user role.'
      });
    }

    if (teamId) {
      const { data: team, error: teamLookupError } = await supabaseAdmin
        .from('teams')
        .select('id')
        .eq('id', teamId)
        .maybeSingle();

      if (teamLookupError) throw teamLookupError;

      if (!team) {
        return res.status(400).json({
          success: false,
          error: 'Selected team does not exist.'
        });
      }
    }

    const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(
      email.trim(),
      {
        data: { full_name: safeText(fullName, 150) },
        redirectTo: process.env.APP_URL || 'https://internal-intake-sow-website.vercel.app/'
      }
    );

    if (error) throw error;

    const newUserId = data.user.id;

    const { error: profileError } = await supabaseAdmin
      .from('profiles')
      .upsert({
        id: newUserId,
        email: data.user.email || email.trim(),
        full_name: safeText(fullName, 150) || null,
        role: role || 'presales',
        is_active: true,
        password_setup_completed: false
      }, {
        onConflict: 'id'
      });

    if (profileError) throw profileError;

    if (teamId) {
      const { error: teamError } = await supabaseAdmin
        .from('team_members')
        .upsert({
          team_id: teamId,
          user_id: newUserId
        }, {
          onConflict: 'team_id,user_id'
        });

      if (teamError) throw teamError;
    }

    res.status(201).json({
      success: true,
      message: 'Invitation sent.'
    });
  } catch (error) {
    dbError(
      error,
      res,
      'Unable to invite this user. Check the email and Supabase Auth settings.'
    );
  }
});

// Zendesk integration
async function getZendeskAccessToken() {
  if (zendeskAccessToken && Date.now() < zendeskTokenExpiresAt - 60000) {
    return zendeskAccessToken;
  }

  const response = await fetch(
    `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/oauth/tokens`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.ZENDESK_CLIENT_ID,
        client_secret: process.env.ZENDESK_CLIENT_SECRET,
        scope: 'tickets:write'
      })
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.access_token) {
    console.error('Zendesk OAuth error:', data);
    throw new Error('Zendesk authentication failed.');
  }

  zendeskAccessToken = data.access_token;
  zendeskTokenExpiresAt = Date.now() + Number(data.expires_in || 3600) * 1000;

  return zendeskAccessToken;
}

// Ticket formatting helpers
function safeText(value, max = 5000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function compactFallback(value, max = 500) {
  return safeText(value, max)
    .replace(/^(Ryan|the client)\s+(says|wants|reports|states|requires)\s+/i, '')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '');
}

function dateOnly(value) {
  const text = safeText(value, 1000);
  const fullDate = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(20\d{2})\b/i);
  if (fullDate) {
    const month = `${fullDate[1][0].toUpperCase()}${fullDate[1].slice(1).toLowerCase()}`;
    return `${month} ${Number(fullDate[2])}, ${fullDate[3]}`;
  }
  const isoDate = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (isoDate) {
    const parsed = new Date(`${isoDate[0]}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime())) {
      return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(parsed);
    }
  }
  const monthYear = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})\b/i);
  return monthYear
    ? `${monthYear[1][0].toUpperCase()}${monthYear[1].slice(1).toLowerCase()} ${monthYear[2]}`
    : '';
}

async function generateConciseTicketSummary(data) {
  const answers = Array.isArray(data.answers) ? data.answers : [];
  const validation = data.validationReport || {};

  const answerForItem = (id) =>
    answers.find(a =>
      Array.isArray(a.coveredItemIds) &&
      a.coveredItemIds.includes(id)
    );

  const extractDateFor = (id) => {
    const a = answerForItem(id);

    const source = a
      ? `${safeText(a.answer, 1500)} ${safeText(a.mainPoint || a.evaluation?.mainPoint, 700)}`
      : '';

    const matches = [...source.matchAll(
      /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+(?:\d{1,2}(?:st|nd|rd|th)?[,]?\s+)?20\d{2}\b/gi
    )].map(m => dateOnly(m[0]));

    if (!matches.length) return '';

    return id === 'go_live'
      ? matches[matches.length - 1]
      : matches[0];
  };

  const answerContext = answers.map((a, index) => ({
    number: index + 1,
    checkpoint: safeText(a.checkpointTitle || a.checkpointId, 100),
    question: safeText(a.question, 700),
    originalAnswer: safeText(a.answer, 1800),
    capturedMainPoint: safeText(a.mainPoint || a.evaluation?.mainPoint, 700),
    status: safeText(a.status || a.evaluation?.disposition, 40) || 'answered',
    reason: safeText(a.reason || a.evaluation?.reason, 300),
    needsReview: Boolean(
      a.needsReview ||
      a.evaluation?.needsReview ||
      a.evaluation?.fallback
    ),
    coveredItemIds: Array.isArray(a.coveredItemIds)
      ? a.coveredItemIds
      : []
  }));

  // Use the original answers as the source of truth. This prevents an incomplete
  // AI "main point" from silently dropping systems, dates, counts, or constraints.
  if (
    process.env.OPENAI_API_KEY &&
    (process.env.AI_PROVIDER || '').toLowerCase() !== 'mock'
  ) {
    try {
      const OpenAI = require('openai');

      const client = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        timeout: 35000,
        maxRetries: 0
      });

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
            missingRequired: Array.isArray(validation.missingRequired)
              ? validation.missingRequired
              : [],
            unresolvedOptional: Array.isArray(validation.unresolvedOptional)
              ? validation.unresolvedOptional
              : [],
            warnings: Array.isArray(validation.warnings)
              ? validation.warnings
              : [],
            contradictions: Array.isArray(validation.contradictions)
              ? validation.contradictions
              : []
          }
        }),
        text: {
          format: {
            type: 'json_schema',
            name: 'concise_sow_handover',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                objective: { type: 'string' },
                businessRequirements: {
                  type: 'array',
                  items: { type: 'string' }
                },
                functionalRequirements: {
                  type: 'array',
                  items: { type: 'string' }
                },
                systemsAndData: {
                  type: 'array',
                  items: { type: 'string' }
                },
                operations: {
                  type: 'array',
                  items: { type: 'string' }
                },
                startDate: { type: 'string' },
                goLiveDate: { type: 'string' },
                budget: { type: 'string' },
                deliverables: {
                  type: 'array',
                  items: { type: 'string' }
                },
                acceptance: {
                  type: 'array',
                  items: { type: 'string' }
                },
                internalFollowUps: {
                  type: 'array',
                  items: { type: 'string' }
                }
              },
              required: [
                'objective',
                'businessRequirements',
                'functionalRequirements',
                'systemsAndData',
                'operations',
                'startDate',
                'goLiveDate',
                'budget',
                'deliverables',
                'acceptance',
                'internalFollowUps'
              ],
              additionalProperties: false
            }
          }
        },
        max_output_tokens: 1100
      });

      const result = JSON.parse(response.output_text || '{}');

      // Keep dates as short values, even if the model returns a full sentence.
      result.startDate = extractDateFor('start_date') ||
        compactFallback(result.startDate, 100);

      result.goLiveDate = extractDateFor('go_live') ||
        compactFallback(result.goLiveDate, 100);

      return result;
    } catch (error) {
      console.error('Concise Zendesk summary fallback:', error.message);
    }
  }

  // Prototype/offline fallback: use saved main points, but normalize wording and dates.
  const findAnswer = (id) =>
    answers.find(a =>
      Array.isArray(a.coveredItemIds) &&
      a.coveredItemIds.includes(id)
    );

  const raw = (id) => {
    const a = findAnswer(id);
    return a ? safeText(a.answer, 1500) : '';
  };

  const point = (id) => {
    const a = findAnswer(id);
    return a
      ? compactFallback(a.mainPoint || a.evaluation?.mainPoint || a.answer)
      : '';
  };

  const dateValue = (id) => extractDateFor(id) || point(id);
  const unique = (ids) => [...new Set(ids.map(point).filter(Boolean))];
  const followUps = [];

  for (const a of answers) {
    const status = a.status || a.evaluation?.disposition;
    const itemId = (a.coveredItemIds || [])[0];
    const cp = checkpoints.find(c =>
      c.items.some(i => i.id === itemId)
    );
    const item = cp?.items.find(i => i.id === itemId);
    const label = item?.label || safeText(a.question, 120) || 'Discovery detail';

    if (status === 'unknown') {
      followUps.push(
        `${label}: Client does not know yet${a.reason ? ` (${safeText(a.reason, 180)})` : ''}.`
      );
    }

    if (status === 'delegated') {
      followUps.push(`${label}: Client requests a delivery-team recommendation.`);
    }

    if (
      a.needsReview ||
      a.evaluation?.needsReview ||
      a.evaluation?.fallback
    ) {
      followUps.push(`${label}: Needs internal review.`);
    }
  }

  const missing = [
    ...(validation.missingRequired || []),
    ...(validation.unresolvedOptional || [])
  ];

  missing.forEach(x => {
    followUps.push(`${safeText(x.label || x.id, 180)}: Not yet confirmed.`);
  });

  const systemAnswers = answers.filter(a =>
    (a.coveredItemIds || []).some(id =>
      ['systems', 'integrations'].includes(id)
    )
  );

  const allSystemText = systemAnswers
    .map(a => safeText(a.answer, 1500))
    .join(' ');

  const knownSystems = [];

  if (/microsoft\s*crm|microsoft dynamics|dynamics\s*365|crm/i.test(allSystemText)) {
    knownSystems.push(/microsoft/i.test(allSystemText) ? 'Microsoft CRM' : 'CRM');
  }

  if (/five9/i.test(allSystemText)) knownSystems.push('Five9');
  if (/confluence/i.test(allSystemText)) knownSystems.push('Confluence');

  const systemsAndData = [...new Set(knownSystems)];

  const sections = {
    objective: point('problem'),
    businessRequirements: unique([
      'current_process',
      'pain_points',
      'use_cases',
      'success_criteria'
    ]),
    functionalRequirements: unique([
      'capabilities',
      'automation',
      'ai_routing',
      'users',
      'channels'
    ]),
    systemsAndData: [
      ...systemsAndData,
      ...unique(['migration', 'security', 'tech_stack_preference'])
    ],
    operations: unique([
      'volume',
      'hours',
      'reporting',
      'availability'
    ]),
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
  const projectName =
    safeText(data.projectName, 180) ||
    `${safeText(data.companyName, 150)} - ${safeText(data.projectType, 150)}`;

  const summary = await generateConciseTicketSummary(data);

  const lines = [
    `SOW DISCOVERY — ${projectName}`,
    '',
    'PROJECT DETAILS',
    `Company: ${safeText(data.companyName, 150) || 'Not provided'}`,
    `Contact: ${safeText(data.contactName, 100) || 'Not provided'}${safeText(data.contactEmail, 254) ? ` | ${safeText(data.contactEmail, 254)}` : ''}`,
    `Project type: ${safeText(data.projectType, 150) || 'Not provided'}`
  ];

  if (summary.objective) {
    lines.push('', 'PROJECT OBJECTIVE', `- ${summary.objective}`);
  }

  const addList = (title, values) => {
    const items = Array.isArray(values)
      ? [...new Set(values.map(x => safeText(x, 450)).filter(Boolean))]
      : [];

    if (items.length) {
      lines.push('', title, ...items.map(x => `- ${x}`));
    }
  };

  addList('BUSINESS REQUIREMENTS', summary.businessRequirements);
  addList('FUNCTIONAL REQUIREMENTS', summary.functionalRequirements);
  addList('SYSTEMS & DATA', summary.systemsAndData);
  addList('OPERATIONS & SERVICE LEVELS', summary.operations);

  if (summary.startDate || summary.goLiveDate) {
    lines.push('', 'TIMELINE');

    if (summary.startDate) {
      lines.push(`- Start: ${summary.startDate}`);
    }

    if (summary.goLiveDate) {
      lines.push(`- Go-live: ${summary.goLiveDate}`);
    }
  }

  if (summary.budget) {
    lines.push('', 'BUDGET', `- ${summary.budget}`);
  }

  addList('DELIVERABLES', summary.deliverables);
  addList('ACCEPTANCE CRITERIA', summary.acceptance);

  const followUps = Array.isArray(summary.internalFollowUps)
    ? [...new Set(summary.internalFollowUps.map(x => safeText(x, 400)).filter(Boolean))]
    : [];

  const warnings = Array.isArray(data.validationReport?.warnings)
    ? data.validationReport.warnings
    : [];

  const meaningfulWarnings = warnings
    .map(w => safeText(w, 350))
    .filter(w =>
      w &&
      !w.startsWith('Required project detail still missing or unverified:') &&
      !w.startsWith('Unresolved checklist item:') &&
      !w.startsWith('AI audit follow-up:')
    );

  for (const warning of meaningfulWarnings) {
    if (!followUps.some(x => x.toLowerCase() === warning.toLowerCase())) {
      followUps.push(warning);
    }
  }

  const missingDetails = [
    ...(Array.isArray(data.validationReport?.missingRequired)
      ? data.validationReport.missingRequired
      : []),
    ...(Array.isArray(data.validationReport?.unresolvedOptional)
      ? data.validationReport.unresolvedOptional
      : [])
  ];

  for (const item of missingDetails) {
    const label = safeText(item.label || item.id, 250);

    if (
      label &&
      !followUps.some(x => x.toLowerCase().includes(label.toLowerCase()))
    ) {
      followUps.push(`${label}: Not yet confirmed.`);
    }
  }

  const contradictions = Array.isArray(data.validationReport?.contradictions)
    ? data.validationReport.contradictions
    : [];

  contradictions.forEach(x => {
    const item = `Potential inconsistency: ${safeText(x, 300)}`;

    if (!followUps.some(y => y.toLowerCase() === item.toLowerCase())) {
      followUps.push(item);
    }
  });

  lines.push('', 'INTERNAL TEAM FOLLOW-UP');

  if (followUps.length) {
    lines.push(...followUps.map(x => `- ${x}`));
  } else {
    lines.push('- No outstanding follow-up items recorded.');
  }

  lines.push('', 'Submission: Submitted for internal review.');

  return lines.join('\n');
}

// API routes
app.get('/api/intake-config', (_req, res) => {
  res.json({
    checkpoints,
    maxFollowUpsPerItem: MAX_FOLLOW_UPS_PER_ITEM
  });
});

app.post('/api/next-question', async (req, res) => {
  try {
    const {
      checkpointId,
      projectType,
      projectDescription,
      sessionDetails,
      history
    } = req.body || {};

    if (
      typeof checkpointId !== 'string' ||
      !checkpoints.some(c => c.id === checkpointId)
    ) {
      return res.status(400).json({
        success: false,
        error: 'Invalid checkpoint.'
      });
    }

    const result = await nextQuestion({
      checkpointId,
      projectType,
      projectDescription,
      sessionDetails,
      history
    });

    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Next question error:', error);

    res.status(500).json({
      success: false,
      error: 'Unable to generate the next question. Please try again.'
    });
  }
});

app.post('/api/evaluate-dynamic-answer', async (req, res) => {
  try {
    const {
      checkpointId,
      question,
      answer,
      projectType,
      projectDescription,
      sessionDetails,
      history,
      targetItemIds,
      followUpCounts
    } = req.body || {};

    if (
      typeof checkpointId !== 'string' ||
      typeof question !== 'string' ||
      typeof answer !== 'string' ||
      !answer.trim()
    ) {
      return res.status(400).json({
        success: false,
        error: 'A question and answer are required.'
      });
    }

    const result = await evaluateAnswer({
      checkpointId,
      question,
      answer,
      projectType,
      projectDescription,
      sessionDetails,
      history,
      targetItemIds,
      followUpCounts
    });

    res.json({ success: true, evaluation: result });
  } catch (error) {
    console.error('Dynamic evaluation error:', error);

    res.status(500).json({
      success: false,
      error: 'Unable to evaluate this answer. Please try again.'
    });
  }
});

app.post('/api/validate-intake', async (req, res) => {
  try {
    const data = req.body || {};

    if (!Array.isArray(data.answers)) {
      return res.status(400).json({
        success: false,
        error: 'No discovery answers were provided for validation.'
      });
    }

    const coverage = new Map();

    for (const answer of data.answers) {
      const ids = Array.isArray(answer.coveredItemIds)
        ? answer.coveredItemIds
        : [];

      for (const id of ids) {
        const prior = coverage.get(id) || [];
        prior.push(answer);
        coverage.set(id, prior);
      }
    }

    const requiredLabels = new Map(
      checkpoints.flatMap(cp =>
        cp.items.map(item => [item.id, `${cp.title}: ${item.label}`])
      )
    );

    const missingRequired = requiredForStart
      .filter(id => {
        const records = coverage.get(id) || [];

        return !records.some(a =>
          ['answered', 'accepted', 'delegated'].includes(a.status) &&
          String(a.answer || '').trim() &&
          !a.needsReview &&
          a.status !== 'unknown'
        );
      })
      .map(id => ({
        id,
        label: requiredLabels.get(id) || id
      }));

    const unresolved = checkpoints
      .flatMap(cp => cp.items.map(item => ({ cp, item })))
      .filter(({ item }) => {
        const records = coverage.get(item.id) || [];

        return !records.length ||
          records.every(a => a.status === 'unknown' || a.needsReview);
      })
      .map(({ cp, item }) => ({
        id: item.id,
        label: `${cp.title}: ${item.label}`,
        required: requiredForStart.includes(item.id)
      }));

    const timelineValidation = validateTimelineAnswers(data.answers, { requireGoLive: true });
    for (const id of timelineValidation.invalidItemIds) {
      if (!missingRequired.some(item => item.id === id)) {
        const cp = checkpoints.find(checkpoint => checkpoint.id === 'delivery');
        const item = cp?.items.find(entry => entry.id === id);
        missingRequired.push({ id, label: `Timeline, Budget & Deliverables: ${item?.label || id}` });
      }
    }

    const audit = await validateSession({ session: data });

    const contradictions = [
      ...new Set([
        ...(audit.contradictions || []),
        ...(data.answers || []).flatMap(a =>
          a.evaluation?.contradictions || []
        )
      ])
    ];

    const blockingIssues = [...timelineValidation.issues];

    const warnings = [
      ...timelineValidation.issues.map(issue => `Timeline validation: ${issue}`),
      ...missingRequired.map(x =>
        `Required project detail still missing or unverified: ${x.label}`
      ),
      ...unresolved.map(x =>
        `Unresolved checklist item: ${x.label}`
      ),
      ...(audit.warnings || []),
      ...(audit.missingCriticalDetails || []).map(x =>
        `AI audit follow-up: ${x}`
      ),
      ...contradictions.map(x =>
        `Potential contradiction to review: ${x}`
      )
    ];

    // Discovery warnings are recorded for the delivery team, but do not block ticket submission.
    res.json({
      success: true,
      canSubmit: blockingIssues.length === 0,
      blockingIssues,
      missingRequired,
      unresolvedOptional: unresolved.filter(x => !x.required),
      contradictions,
      warnings,
      auditFallback: Boolean(audit.auditFallback)
    });
  } catch (error) {
    console.error('Final validation error:', error);

    res.status(500).json({
      success: false,
      error: 'Final validation could not complete. Please retry.'
    });
  }
});

app.post('/api/submit-intake', requireAuth, async (req, res) => {
  try {
    const sessionId = req.body?.sessionId;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: 'A session ID is required.'
      });
    }

    const storedSession = await getSessionRecord(sessionId);

    if (!storedSession) {
      return res.status(404).json({
        success: false,
        error: 'Session not found.'
      });
    }

    if (!(await canAccessSession(req.user, storedSession))) {
      return res.status(403).json({
        success: false,
        error: 'You do not have access to submit this session.'
      });
    }

    if (['submitted', 'completed'].includes(storedSession.status)) {
      return res.status(409).json({
        success: false,
        error: 'This session has already been submitted.'
      });
    }

    const data = await sessionWithAnswers(sessionId);

    Object.assign(data, {
      clientName: data.client_name,
      companyName: data.company_name,
      contactName: data.contact_name,
      contactEmail: data.contact_email,
      projectName: data.project_name,
      projectType: data.project_type,
      projectDescription: data.project_description
    });

    if (!data || typeof data !== 'object') {
      return res.status(400).json({
        success: false,
        error: 'Invalid submission.'
      });
    }

    const timelineValidation = validateTimelineAnswers(data.answers, { requireGoLive: true });
    if (!timelineValidation.valid) {
      return res.status(400).json({
        success: false,
        error: `Please correct the timeline dates before submitting: ${timelineValidation.issues.join(' ')}`
      });
    }

    const required = [
      'clientName',
      'companyName',
      'contactName',
      'contactEmail',
      'projectType'
    ];

    const missing = required.filter(k => !safeText(data[k], 500));

    if (missing.length) {
      return res.status(400).json({
        success: false,
        error: `Please complete: ${missing.join(', ')}.`
      });
    }

    const email = safeText(data.contactEmail, 254);

    const emailPattern =
      /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i;

    if (!emailPattern.test(email)) {
      return res.status(400).json({
        success: false,
        error: 'Please enter a valid contact email.'
      });
    }

    if (!Array.isArray(data.answers) || data.answers.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No discovery answers were recorded.'
      });
    }

    // Do not block Zendesk submission for discovery gaps or validation warnings.
    // Only actual submission requirements (contact details, an answer record, and Zendesk availability) are enforced here.
    const ticketBody = await formatTicket(data);
    const token = await getZendeskAccessToken();

    const zd = await fetch(
      `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          ticket: {
            subject: `[SOW Discovery] - ${safeText(data.projectName, 180) || safeText(data.companyName, 150) + ' - ' + safeText(data.projectType, 100)}`,
            requester: {
              name: safeText(data.contactName, 100),
              email
            },
            comment: {
              body: ticketBody,
              public: false
            },
            status: 'new',
            tags: [
              'sow_intake',
              'presales_discovery',
              'pending_sow_review'
            ]
          }
        })
      }
    );

    const zdData = await zd.json().catch(() => null);

    if (!zd.ok || !zdData?.ticket?.id) {
      console.error('Zendesk ticket error:', zdData);

      return res.status(502).json({
        success: false,
        error: 'Zendesk could not create the ticket. Please check the integration settings and try again.'
      });
    }

    const ticket = zdData.ticket;

    const { error: updateError } = await supabaseAdmin
      .from('discovery_sessions')
      .update({
        status: 'submitted',
        zendesk_ticket_id: String(ticket.id),
        submitted_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', sessionId);

    if (updateError) {
      console.error(
        'Ticket created but session status update failed:',
        updateError
      );
    }

    res.status(201).json({
      success: true,
      message: 'SOW discovery submitted to Zendesk.',
      ticketId: ticket.id,
      ticketStatus: ticket.status,
      zendeskUrl: `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/agent/tickets/${ticket.id}`
    });
  } catch (error) {
    console.error('Submission error:', error);

    res.status(500).json({
      success: false,
      error: 'Unable to submit the intake. Please try again.'
    });
  }
});

// Start server on all network interfaces so devices on the same Wi-Fi can connect.
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`SOW Intake Server listening on ${HOST}:${PORT}`);
  console.log(`Local:   http://localhost:${PORT}`);
  console.log(`Network: http://192.168.68.100:${PORT}`);
});
