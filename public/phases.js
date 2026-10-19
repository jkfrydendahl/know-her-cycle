// Four interface stages. Menstruation is biologically part of the follicular phase.
export const PHASES = [
  { id: 'menstrual', name: 'Menstrual', short: 'Period', color: '#a44156', eyebrow: 'A little room to rest', line: 'A new cycle, at your own pace.', next: 'Follicular' },
  { id: 'follicular', name: 'Follicular', short: 'Follicular', color: '#416c59', eyebrow: 'Space for a fresh start', line: 'A new chapter in this cycle.', next: 'Ovulatory' },
  { id: 'ovulatory', name: 'Ovulatory', short: 'Ovulatory', color: '#9b681f', eyebrow: 'A moment in the cycle', line: 'Stay curious. Stay connected.', next: 'Luteal' },
  { id: 'luteal', name: 'Luteal', short: 'Luteal', color: '#695180', eyebrow: 'Time to check in', line: 'Make room for what feels right.', next: 'Menstrual' }
];
export const phaseById = (id) => PHASES.find((phase) => phase.id === id);
