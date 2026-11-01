const tty = process.stdout.isTTY;
const c = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const dim = c('2');
export const bold = c('1');
export const amber = c('33');
export const red = c('31');
export const green = c('32');
export const cyan = c('36');
export const magenta = c('35');
