// Demo data. Everything here is fictional and flagged `demo: true`, so the app
// can label it and remove it in one step. Dates are generated relative to
// today (Asia/Dubai) so the demo always has something due today.

import { todayInDubai, addDays, weekdayOf, interpretDates, formatDate } from '../shared/dates.js';

const WD_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (iso, withYear = true) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MON_LONG[m - 1]}${withYear ? ' ' + y : ''}`;
};

/** Pick an email date and a weekday so that "next <weekday>" really has two readings. */
function pickAmbiguous(today) {
  for (const back of [2, 3, 1, 4]) {
    const written = addDays(today, -back);
    for (const fwd of [1, 2, 3, 0, 4, 5]) {
      const name = WD_LONG[weekdayOf(addDays(today, fwd))];
      if (interpretDates(`next ${name}`, written)[0].alternatives.length) return { written, name };
    }
  }
  return { written: addDays(today, -2), name: 'Thursday' };
}

export async function seedDemo(dexter) {
  const today = todayInDubai();
  const { written, name } = pickAmbiguous(today);

  const email = await dexter.importSource({
    kind: 'email',
    demo: true,
    useAI: false,
    text: `From: Dr. Laila Haddad <l.haddad@falconbay.example>
To: Capstone Group 4
Date: ${formatDate(written).replace(' ', ', ')} 09:14
Subject: Capstone: report, presentation slot, a few loose ends

Hi all,

Quick update after the committee meeting, sorry for the brain-dump.

The committee has decided to move the Group 4 presentation to ${longDate(addDays(today, 9))}, room B-204, instead of the original slot. The draft report is due next ${name} at 5pm. Upload it to the course portal, not by email.

Please send me your updated project timeline by ${longDate(today, false)} so I can sign it off.

Can someone confirm whether you still need the robotics lab on Saturday mornings? I have not heard back from the ethics office about your survey form, so treat approval as pending.

We agreed that Group 4 will use the shared dataset rather than collecting new data. Also, who is presenting the methodology section?

Best,
Laila

(Falcon Bay University is fictional. This email is demo data.)`,
  });

  const note = await dexter.importSource({
    kind: 'note',
    demo: true,
    useAI: false,
    sourceDate: addDays(today, -1),
    title: 'Personal admin: week notes',
    text: `Personal admin: week notes (demo)

- Car registration renewal: pay before ${longDate(addDays(today, 6), false)}, need the insurance PDF first.
- Decided to go with the Marina gym membership and cancel the old one.
- Call the dentist tomorrow to move the cleaning appointment.
- Ask Omar if he can cover football pickup on Saturday?
- Passport photos: do I need the white background ones?
- Flat viewing with the agent, end of next week.`,
  });

  const byQuote = (source, needle) => dexter.state.findings.find((f) => f.sourceId === source.id && f.evidence.quote.includes(needle));

  const timeline = byQuote(email, 'project timeline');
  if (timeline) {
    dexter.updateFinding(timeline.id, { title: 'Send updated project timeline to Dr. Haddad' });
    dexter.taskFromFinding(timeline.id, { today: true });
  }
  const dentist = byQuote(note, 'dentist');
  if (dentist) {
    dexter.updateFinding(dentist.id, { title: 'Call the dentist to move the cleaning appointment' });
    dexter.taskFromFinding(dentist.id, { today: true });
  }
  const ethics = byQuote(email, 'ethics office');
  if (ethics) {
    dexter.updateFinding(ethics.id, { title: 'Ethics office approval for the survey form' });
    const t = dexter.taskFromFinding(ethics.id);
    dexter.updateTask(t.id, { status: 'waiting', waitingOn: 'Ethics office' });
    t.waitingSince = addDays(today, -3);
  }
  const omar = byQuote(note, 'Omar');
  if (omar) {
    dexter.updateFinding(omar.id, { title: 'Omar: can he cover football pickup on Saturday?' });
    const t = dexter.taskFromFinding(omar.id);
    dexter.updateTask(t.id, { status: 'waiting', waitingOn: 'Omar' });
    t.waitingSince = addDays(today, -1);
  }
  const lab = byQuote(email, 'robotics lab');
  if (lab) await dexter.createDraft({ findingId: lab.id, kind: 'email' });

  // the demo's edits were made by this script, not by the user
  for (const f of dexter.state.findings) if (f.demo) f.edited = false;
  note.dateBasis = 'now';

  dexter.createTask({ title: 'Return library books to the Falcon Bay library', due: { date: addDays(today, -1) }, demo: true });
  const done = dexter.createTask({ title: 'Download the insurance PDF for the car registration', demo: true });
  dexter.updateTask(done.id, { status: 'done' });
  dexter.save();
}
