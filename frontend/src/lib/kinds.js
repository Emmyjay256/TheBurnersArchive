// The only coloured things in the app: the three kinds of fire spot.
export const KIND = {
  live: { label: 'Live fire', hint: 'Detected in the last 48 hours', hex: '#ef4444' },
  expected: { label: 'Expected', hint: 'Usually burns this month, or an unconfirmed low-confidence detection', hex: '#f59e0b' },
  history: { label: 'Past fire', hint: 'Detected earlier in the last 10 days', hex: '#a78bfa' },
};