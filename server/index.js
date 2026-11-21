import { createApp } from './app.js';
import { materialize } from './ledger.js';
import { sendDueReminders, mailConfigured } from './mail.js';
import { DATA_DIR } from './db.js';

const port = Number(process.env.PORT) || 4000;
// Bound to this computer only by default. Set HOST=0.0.0.0 to reach it from other devices (use HTTPS in front of it).
const host = process.env.HOST || '127.0.0.1';

materialize(true);
const app = createApp();
const server = app.listen(port, host, () => {
  console.log(`Dexter Payments is running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  console.log(`Data folder: ${DATA_DIR}`);
  console.log(`Email reminders: ${mailConfigured() ? 'SMTP configured' : 'not configured (in-app reminders only)'}`);
});

// Email digests: checked on start and every 30 minutes; each reminder is emailed once.
const tick = () => sendDueReminders().catch((e) => console.error(`Reminder email failed: ${e.message}`));
if (mailConfigured()) { setTimeout(tick, 5000).unref(); setInterval(tick, 30 * 60 * 1000).unref(); }

// Safety net: a failed background task is logged (name and message only, never record data) instead of stopping the app.
process.on('unhandledRejection', (e) => console.error(`${new Date().toISOString()} ERROR background task failed: ${e?.name || 'Error'}: ${String(e?.message || e).slice(0, 200)}`));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
