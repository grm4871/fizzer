const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseClaudeUsageText,
  parseCodexRateLimits,
  parseGrokUsageScreen,
  parseNousUsageJson,
} = require('./plan-usage.cjs');

test('parses Claude session and weekly subscription windows', () => {
  const usage = parseClaudeUsageText([
    'You are currently using your subscription to power your Claude Code usage',
    '',
    'Current session: 100% used · resets Jul 30, 5am (America/New_York)',
    'Current week (all models): 17% used · resets Aug 5, 1pm (America/New_York)',
  ].join('\n'));

  assert.equal(usage.status, 'ok');
  assert.equal(usage.usedPercent, 100);
  assert.deepEqual(
    usage.windows.map(({ label, usedPercent }) => ({ label, usedPercent })),
    [
      { label: 'session', usedPercent: 100 },
      { label: 'week', usedPercent: 17 },
    ],
  );
});

test('parses Codex structured rate-limit windows', () => {
  const usage = parseCodexRateLimits({
    rateLimits: {
      primary: { usedPercent: 67, windowDurationMins: 10_080, resetsAt: 1_785_955_403 },
      secondary: { usedPercent: 22, windowDurationMins: 300, resetsAt: 1_785_400_000 },
      planType: 'prolite',
    },
  });

  assert.equal(usage.planType, 'prolite');
  assert.equal(usage.usedPercent, 67);
  assert.equal(usage.windows[0].label, '7d');
  assert.equal(usage.windows[1].label, '5h');
  assert.match(usage.windows[0].resetsAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('parses Grok TUI usage through terminal control sequences', () => {
  const usage = parseGrokUsageScreen(
    '\u001b[4;5H\u001b[2mWeekly limit: 12%\u001b[5;5HNext reset: August 2, 09:02\u001b[0m',
  );

  assert.equal(usage.status, 'ok');
  assert.equal(usage.usedPercent, 12);
  assert.equal(usage.windows[0].label, 'week');
  assert.equal(usage.windows[0].resetsLabel, 'August 2, 09:02');
});

test('parses Nous credits subscription window from Hermes portal snapshot', () => {
  const usage = parseNousUsageJson({
    provider: 'nous',
    plan: 'Free',
    windows: [{ label: 'Subscription', usedPercent: 100, detail: '$0.00 of $0.10 left' }],
    details: ['Subscription credits: $0.00', 'Top-up credits: $9.99', 'Total usable: $9.99'],
  });

  assert.equal(usage.status, 'ok');
  assert.equal(usage.planType, 'Free');
  assert.equal(usage.usedPercent, 100);
  assert.equal(usage.windows[0].label, 'Subscription');
  assert.equal(usage.windows[0].resetsLabel, '$0.00 of $0.10 left');
  assert.match(usage.detail, /Top-up credits: \$9.99/);
});

test('parses Nous snapshot with no subscription window (top-up only)', () => {
  const usage = parseNousUsageJson({
    provider: 'nous',
    plan: null,
    windows: [],
    details: ['Top-up credits: $5.00', 'Total usable: $5.00'],
  });

  assert.equal(usage.status, 'ok');
  assert.equal(usage.windows.length, 0);
  assert.match(usage.detail, /Total usable: \$5.00/);
});
