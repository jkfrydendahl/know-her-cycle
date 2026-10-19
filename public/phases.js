// Four interface stages. Menstruation is biologically part of the follicular phase.
export const PHASES = [
  { id: 'menstrual', name: 'Menstrual', emoji: '😭', short: 'Period', color: '#a44156', eyebrow: 'A little room to rest', line: 'A new cycle, at your own pace.', next: 'Follicular' },
  { id: 'follicular', name: 'Follicular', emoji: '🤗', short: 'Follicular', color: '#416c59', eyebrow: 'Space for a fresh start', line: 'A new chapter in this cycle.', next: 'Ovulating' },
  { id: 'ovulatory', name: 'Ovulating', emoji: '😽', short: 'Ovulating', color: '#9b681f', eyebrow: 'A moment in the cycle', line: 'Stay curious. Stay connected.', next: 'Luteal' },
  { id: 'luteal', name: 'Luteal', emoji: '🤬', short: 'Luteal', color: '#695180', eyebrow: 'Time to check in', line: 'Make room for what feels right.', next: 'Menstrual' }
];
export const phaseById = (id) => PHASES.find((phase) => phase.id === id);
