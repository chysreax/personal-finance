/**
 * Automated expense categorisation. Three tiers, most specific first:
 *   1. user rules        — "payee contains X → category"
 *   2. learned history   — what you categorised this payee as before (majority vote)
 *   3. keyword knowledge — built-in merchant/keyword dictionary
 * Rules use plain substring matching (no user-supplied regex → no ReDoS).
 */
import { UNCATEGORIZED } from './schema.js';
import { live } from './finance.js';

const KEYWORDS = [
  ['cat_salary', /\b(salary|payroll|paycheck|gaji|wages|direct dep)/],
  ['cat_freelance', /\b(invoice|freelance|upwork|fiverr|consulting|client payment)/],
  ['cat_investment_income', /\b(dividend|interest earned|coupon|capital gain|staking)/],
  ['cat_refunds', /\b(refund|reimburse|cashback|chargeback)/],
  ['cat_groceries', /\b(grocer|supermarket|whole foods|trader joe|aldi|lidl|kroger|safeway|tesco|walmart|costco|indomaret|alfamart|carrefour|market)/],
  ['cat_dining', /\b(restaurant|cafe|coffee|starbucks|mcdonald|burger|pizza|sushi|kfc|chipotle|doordash|ubereats|uber eats|grubhub|grabfood|gofood|bakery|bistro|bar\b|pub\b|diner)/],
  ['cat_transport', /\b(uber|lyft|grab|gojek|taxi|metro|transit|parking|fuel|gas station|shell|chevron|exxon|pertamina|train|bus\b|toll)/],
  ['cat_housing', /\b(rent|mortgage|landlord|property|hoa\b|apartment)/],
  ['cat_utilities', /\b(electric|power|water|internet|broadband|comcast|verizon|at&t|t-mobile|telkom|pln\b|utility|gas bill|phone bill)/],
  ['cat_subscriptions', /\b(netflix|spotify|hulu|disney|youtube premium|apple\.com|icloud|prime video|hbo|patreon|substack|adobe|dropbox|github|chatgpt|openai|notion|subscription)/],
  ['cat_shopping', /\b(amazon|ebay|target|ikea|shopee|tokopedia|lazada|zara|h&m|uniqlo|best buy|etsy|mall)/],
  ['cat_health', /\b(pharmacy|cvs|walgreens|clinic|hospital|dental|doctor|medical|gym|fitness|optician)/],
  ['cat_entertainment', /\b(cinema|movie|theater|theatre|concert|steam|playstation|xbox|nintendo|ticketmaster|museum|game)/],
  ['cat_travel', /\b(airline|airbnb|hotel|booking\.com|expedia|agoda|traveloka|flight|delta|united|emirates|garuda)/],
  ['cat_education', /\b(tuition|course|udemy|coursera|school|university|book|kindle)/],
  ['cat_insurance', /\b(insurance|geico|allianz|prudential|axa|bpjs)/],
  ['cat_personal', /\b(salon|barber|spa|cosmetic|sephora)/],
  ['cat_gifts', /\b(donation|charity|gift|church|mosque|zakat)/],
  ['cat_fees', /\b(fee|interest charge|overdraft|atm|service charge|late charge)/],
];

export function normalizePayee(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[#*]\s*\d+/g, ' ')
    .replace(/\b(inc|llc|ltd|co|corp|pte|pt|tbk|store|payment|pos|purchase)\b\.?/g, ' ')
    .replace(/\d{3,}/g, ' ')
    .replace(/[^\p{L}\p{N}&.' ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const models = new WeakMap();

/** payee → {categoryId → count}, built once per data snapshot. */
function historyModel(data) {
  let m = models.get(data);
  if (m) return m;
  m = new Map();
  for (const t of live(data.transactions)) {
    if (t.type === 'transfer' || !t.categoryId || t.categoryId === UNCATEGORIZED) continue;
    const key = `${t.type}:${normalizePayee(t.payee)}`;
    if (!key.endsWith(':')) {
      const votes = m.get(key) || new Map();
      votes.set(t.categoryId, (votes.get(t.categoryId) || 0) + 1);
      m.set(key, votes);
    }
  }
  models.set(data, m);
  return m;
}

/**
 * @returns {{categoryId: string, source: 'rule'|'history'|'keyword', confidence: number} | null}
 */
export function suggestCategory(data, payee, type = 'expense') {
  if (type === 'transfer') return null;
  const norm = normalizePayee(payee);
  if (!norm) return null;
  const valid = new Set(live(data.categories).filter((c) => c.kind === type).map((c) => c.id));

  for (const r of live(data.rules)) {
    if (valid.has(r.categoryId) && norm.includes(r.pattern)) return { categoryId: r.categoryId, source: 'rule', confidence: 1 };
  }

  const votes = historyModel(data).get(`${type}:${norm}`);
  if (votes) {
    let best = null;
    let total = 0;
    for (const [cat, n] of votes) {
      total += n;
      if (valid.has(cat) && (!best || n > best[1])) best = [cat, n];
    }
    if (best) return { categoryId: best[0], source: 'history', confidence: best[1] / total };
  }

  for (const [cat, re] of KEYWORDS) {
    if (valid.has(cat) && re.test(norm)) return { categoryId: cat, source: 'keyword', confidence: 0.6 };
  }
  return null;
}

/** Apply suggestions to uncategorised transactions. Returns changed records (caller dispatches). */
export function autoCategorizeAll(data) {
  const changed = [];
  for (const t of live(data.transactions)) {
    if (t.type === 'transfer' || (t.categoryId && t.categoryId !== UNCATEGORIZED)) continue;
    const s = suggestCategory(data, t.payee, t.type);
    if (s) changed.push({ ...t, categoryId: s.categoryId });
  }
  return changed;
}

export const SOURCE_LABEL = { rule: 'your rule', history: 'learned from history', keyword: 'merchant match' };
