export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const fmtDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
// tint of the foreground colour: greys that follow the theme
export const tint = (a) => `rgba(var(--fg-rgb), ${a})`;