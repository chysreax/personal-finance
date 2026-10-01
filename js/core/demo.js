/**
 * Deterministic demo dataset (12 months of realistic activity) so every
 * feature — charts, budgets, forecasts, detection, insights — has data to show.
 */
import * as D from './dates.js';
import { emptyData } from './schema.js';
import { uid } from './ids.js';

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateDemoData(today = D.todayISO(), seed = 20261001) {
  const r = rng(seed);
  const between = (lo, hi) => Math.round((lo + r() * (hi - lo)) * 100);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const now = Date.now();
  const data = emptyData();

  const acc = (name, type, opening, color) => {
    const a = { id: uid('acc_'), name, type, opening, archived: false, color, updatedAt: now, deleted: false };
    data.accounts.push(a);
    return a.id;
  };
  const checking = acc('Everyday Checking', 'checking', 240_000, 0);
  const savings = acc('High-Yield Savings', 'savings', 850_000, 2);
  const card = acc('Rewards Credit Card', 'credit', -65_000, 7);
  const brokerage = acc('Brokerage', 'investment', 1_200_000, 6);

  const txs = [];
  const add = (date, type, amount, payee, categoryId, accountId, extra = {}) => {
    if (date > today) return;
    txs.push({
      id: uid('tx_'), date, type, amount, payee, categoryId: type === 'transfer' ? null : categoryId, accountId,
      toAccountId: null, note: '', tags: [], recurringId: null, createdAt: now, updatedAt: now, deleted: false, ...extra,
    });
  };

  const months = D.lastNMonths(12, today);
  const recIds = { salary: uid('rec_'), rent: uid('rec_'), netflix: uid('rec_'), spotify: uid('rec_'), gym: uid('rec_'), insurance: uid('rec_') };

  months.forEach((key, mi) => {
    const day = (d) => `${key}-${String(Math.min(d, D.daysInMonth(+key.slice(0, 4), +key.slice(5)))).padStart(2, '0')}`;
    add(day(25), 'income', 520_000, 'Acme Corp Payroll', 'cat_salary', checking, { recurringId: recIds.salary });
    add(day(1), 'expense', 165_000, 'Parkview Apartments Rent', 'cat_housing', checking, { recurringId: recIds.rent });
    add(day(12), 'expense', between(98, 136), 'City Electric & Power', 'cat_utilities', checking);
    add(day(18), 'expense', 6_500, 'Comcast Internet', 'cat_utilities', checking);
    add(day(20), 'expense', 4_500, 'T-Mobile Phone Bill', 'cat_utilities', checking);
    add(day(22), 'expense', 12_800, 'Geico Auto Insurance', 'cat_insurance', checking, { recurringId: recIds.insurance });
    add(day(7), 'expense', 1_549, 'Netflix', 'cat_subscriptions', card, { recurringId: recIds.netflix });
    add(day(14), 'expense', 1_199, 'Spotify', 'cat_subscriptions', card, { recurringId: recIds.spotify });
    add(day(3), 'expense', 299, 'Apple iCloud', 'cat_subscriptions', card);
    add(day(5), 'expense', 3_900, 'Equinox Gym', 'cat_health', card, { recurringId: recIds.gym });
    add(day(26), 'transfer', 60_000, 'Transfer to savings', null, checking, { toAccountId: savings });
    add(day(27), 'transfer', 50_000, 'Brokerage contribution', null, checking, { toAccountId: brokerage });
    if (mi % 3 === 1) add(day(15), 'income', between(400, 1400), 'Upwork Freelance Invoice', 'cat_freelance', checking, { tags: ['side-hustle'] });
    if (mi % 3 === 2) add(day(28), 'income', between(60, 140), 'Brokerage Dividend', 'cat_investment_income', brokerage);

    const isCurrent = mi === months.length - 1;
    for (let d = 1; d <= 31; d++) {
      const date = day(d);
      if (+date.slice(8) !== d) break;
      const dow = D.parseISO(date).getDay();
      if (dow === 6 || (dow === 3 && r() < 0.5)) add(date, 'expense', between(55, 165), pick(["Trader Joe's", 'Whole Foods Market', 'Costco Wholesale']), 'cat_groceries', card);
      if (r() < (isCurrent ? 0.42 : 0.24)) add(date, 'expense', between(14, 68), pick(['Chipotle', 'Blue Door Bistro', 'Sushi Zen', 'Pizza Napoli', 'Uber Eats']), 'cat_dining', card, r() < 0.2 ? { tags: ['work'] } : {});
      if (dow >= 1 && dow <= 5 && r() < 0.35) add(date, 'expense', between(4, 7), 'Starbucks', 'cat_dining', card);
      if (r() < 0.1) add(date, 'expense', between(9, 32), 'Uber', 'cat_transport', card);
      if (d === 9 || d === 23) add(date, 'expense', between(38, 58), 'Shell Fuel Station', 'cat_transport', card);
      if (r() < 0.09) add(date, 'expense', between(15, 120), pick(['Amazon', 'Target', 'IKEA']), 'cat_shopping', card);
      if (r() < 0.05) add(date, 'expense', between(12, 60), pick(['AMC Cinema', 'Steam Games', 'Ticketmaster']), 'cat_entertainment', card);
      if (r() < 0.025) add(date, 'expense', between(10, 45), 'CVS Pharmacy', 'cat_health', card);
      if (r() < 0.02) add(date, 'expense', between(25, 45), 'Main St Barber', 'cat_personal', card);
    }
    if (key.endsWith('-12')) {
      add(day(14), 'expense', between(180, 260), 'Holiday gifts', 'cat_gifts', card, { tags: ['family'] });
      add(day(20), 'expense', 10_000, 'Red Cross Donation', 'cat_gifts', checking, { tags: ['tax-deductible'] });
    }
    if (mi === 7) {
      add(day(4), 'expense', 68_400, 'Airbnb Lisbon', 'cat_travel', card, { tags: ['vacation'] });
      add(day(2), 'expense', 42_150, 'Delta Air Lines', 'cat_travel', card, { tags: ['vacation'] });
    }
    if (mi === 9) add(day(11), 'expense', 1_999, 'Udemy Course', 'cat_education', card);
  });

  // Uncategorised imports to showcase auto-categorisation.
  add(D.addDays(today, -2), 'expense', 2_340, 'SQ *GREEN VALLEY MARKET', 'cat_uncategorized', card);
  add(D.addDays(today, -1), 'expense', 1_875, 'LYFT RIDE 4471', 'cat_uncategorized', card);
  // One unusually large purchase for the anomaly detector.
  add(D.addDays(today, -4), 'expense', 34_900, 'Best Buy Electronics', 'cat_shopping', card, { note: 'Noise-cancelling headphones' });

  // Pay the credit card in full on the 28th of each month.
  txs.sort((a, b) => (a.date < b.date ? -1 : 1));
  let owed = 65_000;
  const payments = [];
  for (const t of txs) {
    while (payments.length < months.length && `${months[payments.length]}-28` <= t.date) {
      const pd = `${months[payments.length]}-28`;
      if (pd <= today && owed > 0) {
        payments.push({ date: pd, amount: owed });
        owed = 0;
      } else payments.push(null);
    }
    if (t.accountId === card && t.type === 'expense') owed += t.amount;
  }
  for (const p of payments) if (p) add(p.date, 'transfer', p.amount, 'Credit card payment', null, checking, { toAccountId: card });
  data.transactions = txs;

  const mkRec = (id, payee, amount, type, categoryId, accountId, frequency, nextDay, active = true) => {
    let next = `${D.monthKey(today)}-${String(nextDay).padStart(2, '0')}`;
    if (next <= today) next = D.addMonths(next, 1);
    data.recurring.push({ id, payee, amount, type, categoryId, accountId, frequency, nextDate: next, active, note: '', updatedAt: now, deleted: false });
  };
  mkRec(recIds.salary, 'Acme Corp Payroll', 520_000, 'income', 'cat_salary', checking, 'monthly', 25);
  mkRec(recIds.rent, 'Parkview Apartments Rent', 165_000, 'expense', 'cat_housing', checking, 'monthly', 1);
  mkRec(recIds.netflix, 'Netflix', 1_549, 'expense', 'cat_subscriptions', card, 'monthly', 7);
  mkRec(recIds.spotify, 'Spotify', 1_199, 'expense', 'cat_subscriptions', card, 'monthly', 14);
  mkRec(recIds.insurance, 'Geico Auto Insurance', 12_800, 'expense', 'cat_insurance', checking, 'monthly', 22);
  data.recurring.push({
    id: recIds.gym, payee: 'Equinox Gym', amount: 3_900, type: 'expense', categoryId: 'cat_health', accountId: card,
    frequency: 'monthly', nextDate: today, active: true, note: 'Due today — try "Post now"', updatedAt: now, deleted: false,
  });
  // The current-month gym charge has not been posted yet.
  data.transactions = data.transactions.filter((t) => !(t.recurringId === recIds.gym && D.monthKey(t.date) === D.monthKey(today)));

  const budget = (categoryId, limit) => data.budgets.push({ id: uid('bud_'), categoryId, limit, updatedAt: now, deleted: false });
  budget('cat_groceries', 70_000);
  budget('cat_dining', 30_000);
  budget('cat_transport', 25_000);
  budget('cat_shopping', 30_000);
  budget('cat_entertainment', 12_000);
  budget('cat_subscriptions', 5_000);
  budget('cat_utilities', 30_000);

  const history = (amount, n) =>
    Array.from({ length: n }, (_, i) => ({ date: D.addMonths(today, -(n - i - 1)).slice(0, 8) + '01', amount }));
  data.goals.push(
    { id: uid('goal_'), name: 'Emergency fund', target: 2_000_000, saved: 1_270_000, deadline: D.addMonths(today, 10), color: 2, icon: '🛟', history: history(60_000, 6), updatedAt: now, deleted: false },
    { id: uid('goal_'), name: 'Japan trip', target: 450_000, saved: 135_000, deadline: D.addMonths(today, 6), color: 4, icon: '🗾', history: history(25_000, 4), updatedAt: now, deleted: false },
    { id: uid('goal_'), name: 'New laptop', target: 220_000, saved: 165_000, deadline: null, color: 0, icon: '💻', history: history(27_500, 6), updatedAt: now, deleted: false },
  );
  data.rules.push({ id: uid('rule_'), pattern: 'farmers market', categoryId: 'cat_groceries', updatedAt: now, deleted: false });
  data.settings = { currency: 'USD', budgetWarn: 0.8, updatedAt: now };
  return data;
}
